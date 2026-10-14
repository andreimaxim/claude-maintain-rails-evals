# frozen_string_literal: true

require "digest"
require "fileutils"
require "json"
require "net/http"
require "open3"
require "rbconfig"
require "timeout"
require "uri"

module UpgradeSupport
  module_function

  def command(*args, directory: Dir.pwd, seconds: 240)
    output = +""
    status = nil
    Open3.popen2e({ "GIT_TERMINAL_PROMPT" => "0" }, *args, chdir: directory, pgroup: true) do |input, stream, thread|
      input.close
      begin
        Timeout.timeout(seconds) { output << stream.read; status = thread.value }
      rescue Timeout::Error
        Process.kill("TERM", -thread.pid) rescue nil
        sleep 0.2
        Process.kill("KILL", -thread.pid) rescue nil
        raise "Command timed out after #{seconds}s: #{args.first}"
      end
    end
    raise "#{args.first} failed: #{output[-2000, 2000] || output}" unless status.success?

    output
  end

  def http(url)
    uri = URI(url)
    6.times do
      raise "Only HTTPS sources are supported: #{uri}" unless uri.is_a?(URI::HTTPS)

      response = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 20, read_timeout: 60) do |client|
        client.get(uri.request_uri, { "User-Agent" => "maintain-rails-gem-changes" })
      end
      return response.body if response.is_a?(Net::HTTPSuccess)
      raise "#{uri}: HTTP #{response.code}" unless response.is_a?(Net::HTTPRedirection)

      uri = URI.join(uri, response.fetch("location"))
    end
    raise "Too many redirects: #{url}"
  end

  # Preserve platforms and source revisions. A version alone is not a lock identity.
  def lock(path)
    section = source = revision = current = nil
    specs = {}
    File.foreach(path) do |line|
      if line.match?(/\A\S/)
        section = line.strip
        source = revision = current = nil
      elsif %w[GEM GIT PATH].include?(section)
        source = line.strip.delete_prefix("remote: ") if line.start_with?("  remote: ")
        revision = line.strip.delete_prefix("revision: ") if line.start_with?("  revision: ")
        if (m = line.match(/\A    ([\w.-]+) \(([^)]+)\)/))
          current = m[1]
          row = (specs[current] ||= { "versions" => [], "sources" => [], "dependencies" => [] })
          row["versions"] << m[2]
          row["sources"] << [section, source, revision]
        elsif current && (m = line.match(/\A      ([\w.-]+)(?: |\n)/))
          specs[current]["dependencies"] << m[1]
        end
      end
    end
    specs.each_value { |row| row.each_value { |values| values.uniq!; values.sort_by!(&:to_s) } }
    specs
  end

  def lock_delta(before, after)
    a, b = lock(before), lock(after)
    defaults = Gem::Specification.select(&:default_gem?).group_by(&:name)
    (a.keys | b.keys).sort.filter_map do |name|
      next if a[name] == b[name]

      { "name" => name, "before" => a[name], "after" => b[name],
        "baseline_default_versions" => a[name] ? [] : defaults.fetch(name, []).map { |spec| spec.version.to_s }.uniq,
        "required_by_before" => a.keys.select { |key| a[key]["dependencies"].include?(name) },
        "required_by_after" => b.keys.select { |key| b[key]["dependencies"].include?(name) } }
    end
  end

  def json(path, value)
    FileUtils.mkdir_p(File.dirname(path))
    File.write(path, JSON.pretty_generate(value) + "\n")
  end

  # Documentation and commits are kept separately from the text matching index.
  # Fetch exact tags, never silently substitute the default branch or a nearby tag.
  def upstream(name, metadata, from, to, versions, directory, cache)
    source = metadata["source_code_uri"].to_s
    match = source.match(%r{\Ahttps://github\.com/([\w.-]+)/([\w.-]+)})
    match ||= metadata.values.filter_map { |url| url.to_s.match(%r{\Ahttps://github\.com/([\w.-]+)/([\w.-]+)}) }.first
    unless match
      result = { "status" => "missing", "reason" => "No supported GitHub repository in gem metadata" }
      json(File.join(directory, "sources.json"), result)
      return result
    end

    owner, repo = match[1], match[2].delete_suffix(".git")
    url = "https://github.com/#{owner}/#{repo}.git"
    store = File.join(cache, "git", "#{owner}-#{repo}.git")
    FileUtils.mkdir_p(File.dirname(store))
    command("git", "init", "--bare", store) unless File.directory?(store)
    tags = command("git", "ls-remote", "--tags", "--refs", url).lines.to_h do |line|
      sha, ref = line.split
      [ref.delete_prefix("refs/tags/"), sha]
    end
    resolve = lambda do |version|
      ["v#{version}", version.to_s, "#{name}-#{version}", "#{name}/v#{version}"].find { |tag| tags.key?(tag) }
    end
    refs = [from, *versions, to].uniq.to_h { |version| [version.to_s, resolve.call(version)] }
    missing = refs.select { |_, tag| !tag }.keys
    available = refs.values.compact.uniq
    need = available.reject do |tag|
      begin
        cached_sha = command("git", "--git-dir=#{store}", "rev-parse", "--verify", "refs/tags/#{tag}").strip
        raise "Upstream tag changed: #{tag}; inspect it before replacing the cache" unless cached_sha == tags[tag]
        command("git", "--git-dir=#{store}", "rev-parse", "--verify", "refs/tags/#{tag}^{commit}")
        true
      rescue RuntimeError
        false
      end
    end
    unless need.empty?
      command("git", "--git-dir=#{store}", "fetch", "--filter=blob:none", "--no-tags", url,
              *need.map { |tag| "refs/tags/#{tag}:refs/tags/#{tag}" }, seconds: 600)
    end
    git = ->(*args) { command("git", "--git-dir=#{store}", *args) }
    FileUtils.mkdir_p(directory)
    documents = []
    document_contents = {}
    refs.each do |version, tag|
      next unless tag

      # Keep full versioned guides, including prose and tables that bullet parsers miss.
      files = git.call("ls-tree", "-r", "--name-only", tag).lines.map(&:strip)
      files.select { |path| path.match?(%r{(?:upgrad|migrat|release.?notes|changelog|changes)}i) || File.basename(path).match?(/\AREADME/i) }.each do |path|
        next unless path.match?(/\.(?:md|markdown|rdoc|rst|txt|textile)\z/i) || File.basename(path).match?(/\A(?:CHANGELOG|CHANGES|UPGRADING)\z/i)
        next if path.match?(%r{(?:\A|/)(?:test|spec|vendor|node_modules)/})

        body = git.call("show", "#{tag}:#{path}")
        digest = Digest::SHA256.hexdigest(body)
        destination = document_contents[digest]
        unless destination
          destination = File.join(directory, "guides", version, path)
          FileUtils.mkdir_p(File.dirname(destination))
          File.write(destination, body)
          document_contents[digest] = destination
        end
        documents << { "version" => version, "tag" => tag, "path" => path,
                       "file" => destination, "sha256" => digest, "url" => "https://github.com/#{owner}/#{repo}/blob/#{tag}/#{path}" }
      end
    end
    result = { "status" => missing.empty? ? "complete" : "partial", "repository" => url,
               "git_dir" => store, "refs" => refs, "tag_shas" => available.to_h { |tag| [tag, tags[tag]] },
               "missing_tags" => missing, "documents" => documents, "guide_status" => documents.empty? ? "not-found" : "found" }
    if refs[from.to_s] && refs[to.to_s]
      range = "#{refs[from.to_s]}..#{refs[to.to_s]}"
      commits = git.call("log", "--reverse", "--format=%H%x09%s", range).lines
      File.write(File.join(directory, "commits.tsv"), commits.join)
      commit_files = git.call("log", "--reverse", "--format=%n%H %s", "--name-only", range)
      File.write(File.join(directory, "commit-files.txt"), commit_files)
      groups = Hash.new { |hash, key| hash[key] = [] }
      current = nil
      commit_files.each_line do |line|
        if line.match?(/\A[0-9a-f]{40} /)
          current = line.strip
        elsif current && !line.strip.empty?
          group = line.split("/").first.strip
          group = "root" unless line.include?("/") && group.match?(/\A[\w.-]+\z/)
          groups[group] << current
        end
      end
      FileUtils.mkdir_p(File.join(directory, "commit-groups"))
      groups.each { |group, rows| File.write(File.join(directory, "commit-groups", "#{group}.txt"), rows.uniq.join("\n") + "\n") }
      File.write(File.join(directory, "changed-files.txt"), git.call("diff", "--name-status", refs[from.to_s], refs[to.to_s]))
      result["commit_count"] = commits.size
      result["range"] = range
      result["compare_url"] = "https://github.com/#{owner}/#{repo}/compare/#{range}"
      # Small gems: read every commit in order. Large gems: use commit-files as
      # an index and retrieve patches with git show, without a lossy keyword filter.
      if commits.size <= 80
        File.open(File.join(directory, "commits.patch"), "w") do |out|
          commits.each { |line| out << git.call("show", "--format=fuller", line.split("\t").first) }
        end
      end
    else
      result["status"] = "partial"
      result["reason"] = "Endpoint tag missing; no verified commit interval"
    end
    json(File.join(directory, "sources.json"), result)
    result
  rescue StandardError => error
    result = { "status" => "partial", "reason" => error.message, "repository" => url, "git_dir" => store }
    json(File.join(directory, "sources.json"), result)
    result
  end
end
