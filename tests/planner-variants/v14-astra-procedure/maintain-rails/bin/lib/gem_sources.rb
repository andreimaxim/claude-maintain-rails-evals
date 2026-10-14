# frozen_string_literal: true

require_relative "upgrade_support"
require "net/http"
require "rubygems/package"
require "set"
require "tmpdir"
require "uri"

module GemSources
  REMOVAL = /\b(remove[sd]?|no longer|drop(?:ped)? support|deleted?|breaking|rename[sd]?)\b/i
  DEPRECATION = /deprecat/i
  BEHAVIOR = /\b(raise[sd]?|now|changed?|default|instead of|incompatib\w*|require[sd]?)\b/i
  STOPWORDS = %w[true false nil self class module def end new config rails ruby gem test tests then else when case each with from into only also this that have will been string symbol hash array integer boolean value values option options method methods name names default defaults error errors call block args params application initialize configure base].to_set.freeze
  GENERIC = %w[Rails ActiveRecord ActiveSupport ActiveModel ActiveJob ActiveStorage ActionController ActionDispatch ActionView ActionMailer ActionCable ActionText ActionMailbox Railties ActiveRecord::Base ActionController::Base ActionMailer::Base ActiveJob::Base ApplicationRecord ArgumentError StandardError RuntimeError NoMethodError NameError TypeError Time Date DateTime String Symbol Hash Array Integer Float Object Class Module JSON YAML].to_set.freeze

  def self.kinds(text)
    [("removal" if text.match?(REMOVAL)), ("deprecation" if text.match?(DEPRECATION)),
     ("behavior" if text.match?(BEHAVIOR))].compact
  end

  def self.identifiers(text)
    spans = text.scan(/`([^`\n]+)`/).flatten
    plain = text.gsub(/`[^`\n]+`/, " ")
    spans += plain.scan(/(?<![\w:]):\w+/) + plain.scan(/"(\w+)"/).flatten + plain.scan(/\b[a-z]+_[a-z_]+\b/)
    spans.flat_map { |span| span.scan(/[A-Z]\w*(?:::[A-Z]\w*)+|[a-z_]\w*[?!]?|:\w+|[A-Z]\w+/) }
         .map { |token| token.delete_prefix(":") }
         .reject { |token| token.length < 4 || STOPWORDS.include?(token.downcase) || GENERIC.include?(token) }.uniq
  end

  def self.heading_version(line)
    number = line[/\A(?:\#{1,6}\s*|\s*(?=\d+\.\d+)).*?(\d+\.\d+(?:\.[0-9a-zA-Z]+)*)/, 1]
    number && Gem::Version.new(number)
  rescue ArgumentError
    nil
  end

  # Markdown guides use both ATX and underlined headings. Preserve the original
  # text and line numbers, and do not treat a heading inside a code block as prose.
  def self.sections(text)
    lines = text.lines
    starts = [0]
    fence = nil
    lines.each_with_index do |line, index|
      if (marker = line.lstrip[/\A(`{3,}|~{3,})/, 1])
        fence = fence ? (marker.start_with?(fence) ? nil : fence) : marker
      elsif !fence && (line.match?(/\A\#{1,2} /) || (!line.strip.empty? && lines[index + 1].to_s.match?(/\A(?:={3,}|-{3,})\s*\z/)))
        starts << index
      end
    end
    (starts.uniq + [lines.size]).each_cons(2).map do |first, last|
      { "heading" => lines[first].to_s.strip, "line" => first + 1, "text" => lines[first...last].join }
    end
  end

  # Preserve full entries and source line numbers; summaries are only indexes.
  def self.entries(text, component, from, to, source)
    result = []
    version = nil
    current = nil
    first_line = nil
    fenced = false
    flush = lambda do
      if current && version && version > from && version <= to
        body = current.join.strip
        result << { "component" => component, "version" => version.to_s, "text" => body,
                    "source" => source, "line" => first_line, "kinds" => kinds(body), "identifiers" => identifiers(body) }
      end
      current = nil
    end
    text.each_line.with_index(1) do |line, number|
      if line.lstrip.start_with?("```")
        fenced = !fenced
        current << line if current
      elsif !fenced && (line.match?(/\A\#{1,6}.*\b(?:unreleased|unreleased changes|next)\b/i))
        flush.call
        version = nil
      elsif !fenced && (found = heading_version(line))
        flush.call
        version = found
      elsif !fenced && line.match?(/\A {0,2}[*-] /)
        flush.call
        current = [line]
        first_line = number
      elsif current
        current << line
      end
    end
    flush.call
    result
  end

  class Cache
    attr_reader :root

    def initialize(app)
      @root = File.expand_path(ENV.fetch("GEM_CHANGES_CACHE", File.join(ENV.fetch("XDG_CACHE_HOME", File.join(Dir.home, ".cache")), "gem-changes-v2")))
      UpgradeSupport.external_output!(@root, app)
      FileUtils.mkdir_p(@root)
    end

    def fetch(url, ttl: nil)
      path = File.join(root, "http", Digest::SHA256.hexdigest(url))
      if !File.file?(path) || (ttl && Time.now - File.mtime(path) > ttl)
        uri = URI(url)
        body = nil
        6.times do
          raise UpgradeSupport::Error, "Only HTTP(S) source URLs are supported" unless %w[http https].include?(uri.scheme)
          response = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", open_timeout: 20, read_timeout: 90) do |http|
            request = Net::HTTP::Get.new(uri)
            request["User-Agent"] = "maintain-rails-gem-changes"
            http.request(request)
          end
          if response.is_a?(Net::HTTPSuccess)
            body = response.body
            break
          end
          raise UpgradeSupport::Error, "#{url}: HTTP #{response.code}" unless response.is_a?(Net::HTTPRedirection)
          uri = URI.join(uri.to_s, response.fetch("location"))
        end
        raise UpgradeSupport::Error, "Too many redirects: #{url}" unless body
        FileUtils.mkdir_p(File.dirname(path))
        temporary = "#{path}.#{Process.pid}.tmp"
        File.binwrite(temporary, body)
        File.rename(temporary, path)
      end
      path
    end

    def metadata(name, version)
      JSON.parse(File.read(fetch("https://rubygems.org/api/v2/rubygems/#{name}/versions/#{version}.json")))
    end

    def versions(name, from, to)
      all = JSON.parse(File.read(fetch("https://rubygems.org/api/v1/versions/#{name}.json", ttl: 3600)))
      candidates = all.reject { |row| row["prerelease"] }.map { |row| Gem::Version.new(row.fetch("number")) }.uniq
      candidates.select { |version| version > from && version <= to }
                .group_by { |version| version.segments.first(2) }.values.map(&:max).push(to).uniq.sort
    end

    def unpack(name, version)
      path = fetch("https://rubygems.org/downloads/#{name}-#{version}.gem")
      directory = File.join(root, "packages", "#{name}-#{version}")
      return directory if File.directory?(directory)
      FileUtils.mkdir_p(File.dirname(directory))
      staging = Dir.mktmpdir("extract-", File.dirname(directory))
      package = Gem::Package.new(path)
      package.verify
      %w[*.md *.rdoc CHANGELOG* CHANGES* Changes* History* HISTORY* docs/* **/new_framework_defaults*].each do |pattern|
        package.extract_files(staging, pattern)
      end
      File.rename(staging, directory)
      directory
    ensure
      FileUtils.remove_entry(staging) if staging && File.exist?(staging)
    end
  end

  class AppIndex
    def initialize(app)
      @files = {}
      %w[app config lib db test spec].each do |directory|
        Dir.glob(File.join(app, directory, "**", "*")).sort.each do |path|
          next unless File.file?(path) && path.match?(/\.(rb|erb|yml|yaml|rake|builder|jbuilder|ru|js|ts)\z/)
          next if File.symlink?(path)
          @files[path.delete_prefix(app + "/")] = File.readlines(path, chomp: true, encoding: "UTF-8", invalid: :replace, undef: :replace)
        end
      end
      @cache = {}
    end

    def hits(identifier)
      @cache[identifier] ||= begin
        escaped = Regexp.escape(identifier)
        pattern = identifier.match?(/\A[a-z]+[?!]?\z/) ? /\.#{escaped}(?!\w)/ : /(?<![\w:])#{escaped}(?!\w)/
        found = @files.flat_map do |file, lines|
          lines.each_with_index.filter_map do |line, index|
            "#{file}:#{index + 1}: #{line.strip[0, 180]}" if !line.lstrip.start_with?("#") && line.match?(pattern)
          end
        end
        count = found.map { |hit| hit.split(":").first }.uniq.size
        limit = identifier.match?(/\A[a-z]+[?!]?\z/) ? 2 : [@files.size / 4, 2].max
        count > limit ? [] : found
      end
    end
  end

  class Repository
    attr_reader :directory, :url, :tags

    def initialize(cache, url)
      @url = url
      @directory = File.join(cache.root, "repositories", Digest::SHA256.hexdigest(url)[0, 20])
      FileUtils.mkdir_p(File.dirname(directory))
      unless File.directory?(directory)
        UpgradeSupport.capture("git", "init", "--bare", "--quiet", directory)
        git("remote", "add", "origin", url)
        git("config", "remote.origin.promisor", "true")
        git("config", "remote.origin.partialclonefilter", "blob:none")
      end
      @tags = UpgradeSupport.capture("git", "ls-remote", "--tags", "--refs", url).lines.to_h do |line|
        sha, ref = line.split
        [ref.delete_prefix("refs/tags/"), sha]
      end
    end

    def git(*args)
      UpgradeSupport.capture("git", "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60", "-C", directory, *args)
    end

    def tag(name, version, override = nil)
      return override if override && tags.key?(override)
      raise UpgradeSupport::Error, "Tag override does not exist: #{override}" if override
      exact = ["v#{version}", version.to_s, "#{name}-#{version}", "#{name}/v#{version}", "#{name}/#{version}", "#{name}_#{version}"]
      found = exact.select { |candidate| tags.key?(candidate) }
      if found.empty?
        found = tags.keys.select { |candidate| candidate.match?(%r{(?:\A|[/_-])v?#{Regexp.escape(version.to_s)}\z}) }
      end
      raise UpgradeSupport::Error, "No exact release tag for #{name} #{version}; use --from-ref/--to-ref" if found.empty?
      raise UpgradeSupport::Error, "Ambiguous tags for #{name} #{version}: #{found.join(', ')}" if found.map { |candidate| tags[candidate] }.uniq.size > 1
      found.first
    end

    def fetch(refs)
      missing = refs.uniq.reject do |ref|
        output, status = Open3.capture2e("git", "-C", directory, "rev-parse", "--verify", "refs/tags/#{ref}^{commit}")
        status.success? && output.strip.match?(/\A[0-9a-f]{40,64}\z/)
      end
      return if missing.empty?
      git("fetch", "--quiet", "--filter=blob:none", "--no-tags", "origin", *missing.map { |ref| "refs/tags/#{ref}:refs/tags/#{ref}" })
    end

    def commit(ref)
      git("rev-parse", "refs/tags/#{ref}^{commit}").strip
    end

    def source_url(sha, path = nil)
      return "#{url.delete_suffix('.git')}/#{path ? "blob/#{sha}/#{path}" : "commit/#{sha}"}" if url.start_with?("https://github.com/")
      "#{url} @ #{sha}#{path && ':' + path}"
    end
  end

  class Collector
    attr_reader :manifest

    def initialize(gem, from, to, app, output, options = {})
      @gem = UpgradeSupport.name!(gem)
      @from = UpgradeSupport.version!(from)
      @to = UpgradeSupport.version!(to)
      raise UpgradeSupport::Error, "Target must be newer than current" unless @to > @from
      @app = File.realpath(app)
      @output = File.expand_path(output)
      UpgradeSupport.external_output!(@output, @app)
      FileUtils.mkdir_p(@output)
      @options = options
      @cache = Cache.new(@app)
      @index = AppIndex.new(@app)
      @repositories = {}
      @repository_ranges = {}
      @entries = []
      @defaults = []
      @package_has_code = {}
      @manifest = { "format" => "gem-changes-v2", "gem" => gem, "from" => from, "to" => to,
                    "app" => @app, "created_at" => Time.now.utc.iso8601, "versions" => [],
                    "pages" => [], "gaps" => [], "dependencies" => [], "requirements" => [] }
    end

    def gap(context, error)
      @manifest["gaps"] << "#{context}: #{error.respond_to?(:message) ? error.message : error}"
    end

    def page(kind, title, text, key: title)
      # Content participates in the ID so a later patch in the same minor series
      # cannot disappear when several manifests are merged into one report.
      identity = [key, text.gsub(@output, "<output>")].join("\0")
      id = "#{kind}-#{Digest::SHA256.hexdigest(identity)[0, 12]}"
      return if @manifest["pages"].any? { |entry| entry["id"] == id }
      relative = "pages/#{id}.md"
      path = File.join(@output, relative)
      FileUtils.mkdir_p(File.dirname(path))
      File.write(path, "# #{title}\n\n#{text}\n")
      @manifest["pages"] << { "id" => id, "kind" => kind, "title" => title, "path" => relative }
      relative
    end

    def metadata(name, version)
      @metadata ||= {}
      @metadata[[name, version.to_s]] ||= @cache.metadata(name, version)
    end

    def components(name, version)
      pending = [name]
      found = []
      until pending.empty?
        component = pending.shift
        next if found.include?(component)
        found << component
        begin
          spec = metadata(component, version)
          pending.concat(spec.dig("dependencies", "runtime").to_a.select do |dependency|
            dependency["requirements"].to_s.match?(/\A=\s*#{Regexp.escape(version.to_s)}\z/)
          end.map { |dependency| dependency.fetch("name") })
        rescue StandardError => error
          gap("#{component} #{version} metadata", error)
        end
      end
      found
    end

    def collect_gem(name, from, to, primary: false)
      versions = @cache.versions(name, from, to)
      @manifest["versions"] = versions.map(&:to_s) if primary
      all_components = []
      (versions + [from]).uniq.each do |version|
        all_components |= components(name, version)
      end
      versions.each do |version|
        components(name, version).each do |component|
          spec = metadata(component, version)
          @manifest["requirements"] << { "gem" => component, "version" => version.to_s, "ruby" => spec["ruby_version"], "runtime" => spec.dig("dependencies", "runtime") }
          directory = @cache.unpack(component, version)
          package = Gem::Package.new(@cache.fetch("https://rubygems.org/downloads/#{component}-#{version}.gem"))
          @package_has_code[component] ||= package.spec.files.any? { |file| file.match?(%r{\A(?:lib|ext)/}) }
          paths = Dir.glob(File.join(directory, "**", "*")).select { |path| File.file?(path) && File.basename(path).match?(/\A(?:change(?:log|s)?|history)/i) }
          paths.each do |path|
            source = "https://rubygems.org/downloads/#{component}-#{version}.gem!#{path.delete_prefix(directory + '/')}"
            @entries.concat(GemSources.entries(File.read(path, encoding: "UTF-8", invalid: :replace), component, from, to, source))
          end
          collect_defaults(directory, component, version)
        rescue StandardError => error
          gap("#{component} #{version} packaged notes", error)
        end
      end
      all_components.each do |component|
        component_versions = versions.select { |version| components(name, version).include?(component) }
        next if component_versions.empty?
        last = component_versions.last
        target_covered = @entries.any? { |entry| entry["component"] == component && Gem::Version.new(entry["version"]).segments.first(2) == last.segments.first(2) }
        # A pure metagem contains only component dependencies, not its own APIs.
        next if component == name && all_components.size > 1 && !@package_has_code[component]
        collect_remote(component, from, last) unless target_covered
      end
      # Framework components share one repository and one tag range. Fetch and
      # index it once, rather than repeat its whole history for every component.
      all_components.each do |component|
        begin
          collect_repository(component, from, to, versions, primary: primary && component == name)
        rescue StandardError => error
          gap("#{component} repository evidence", error)
        end
      end
      page("requirements", "#{name} #{from} to #{to}: versions and dependencies",
           "Sampled releases: #{versions.join(', ')}. Components (union across releases): #{all_components.join(', ')}.\n\n" +
           "Latest stable patch per intervening minor series, plus the exact target. Packaged changelogs are cumulative when upstream provides them; commit history covers the tag range.\n\n" +
           @manifest["requirements"].select { |item| all_components.include?(item["gem"]) }.map do |item|
             "- #{item['gem']} #{item['version']}: Ruby #{item['ruby']}; #{item['runtime'].to_a.map { |dependency| "#{dependency['name']} #{dependency['requirements']}" }.join(', ')}"
           end.join("\n"))
    end

    def repository_url(spec)
      values = spec.slice("source_code_uri", "homepage_uri", "changelog_uri").merge(spec["metadata"].to_h)
      values.values_at("source_code_uri", "homepage_uri", "changelog_uri").compact.each do |text|
        uri = URI(text) rescue next
        next unless uri.scheme == "https"
        if %w[github.com bitbucket.org].include?(uri.host)
          parts = uri.path.split("/").reject(&:empty?).first(2)
          return "https://#{uri.host}/#{parts.join('/').delete_suffix('.git')}.git" if parts.size == 2
        elsif uri.host == "gitlab.com"
          return "https://gitlab.com#{uri.path.split('/-/').first.delete_suffix('.git')}.git"
        elsif uri.path.end_with?(".git")
          return text
        end
      end
      nil
    end

    def collect_remote(component, from, to)
      spec = metadata(component, to)
      values = spec.slice("changelog_uri", "source_code_uri", "homepage_uri").merge(spec["metadata"].to_h)
      url = values["changelog_uri"]
      if url
        url = url.sub(%r{https://github.com/([^/]+)/([^/]+)/blob/}, 'https://raw.githubusercontent.com/\1/\2/')
        path = @cache.fetch(url)
        text = File.read(path, encoding: "UTF-8", invalid: :replace)
        unless text.match?(/\A\s*(?:<!doctype|<html)/i)
          found = GemSources.entries(text, component, from, to, url)
          @entries.concat(found)
          page("remote-notes", "#{component} metadata changelog", "Source: #{url}\n\n#{text}") if found.empty?
          return unless found.empty?
        end
      end
      repo = repository_url(spec)
      match = repo.to_s.match(%r{\Ahttps://github.com/([^/]+)/([^/]+)\.git\z})
      return gap("#{component} release notes", "No parsed packaged or metadata changelog; inspect repository documents") unless match
      found = []
      complete = false
      10.times do |offset|
        release_url = "https://api.github.com/repos/#{match[1]}/#{match[2]}/releases?per_page=100&page=#{offset + 1}"
        releases = JSON.parse(File.read(@cache.fetch(release_url, ttl: 3600)))
        releases.each do |release|
          number = release["tag_name"].to_s[/\d+(?:\.[0-9a-zA-Z]+)+/]
          next unless number
          version = Gem::Version.new(number)
          next unless version > from && version <= to
          body = release["body"].to_s
          found.concat(GemSources.entries("# #{version}\n#{body}", component, from, to, release["html_url"]))
          page("release-notes", "#{component} #{version} release notes", "Source: #{release['html_url']}\n\n#{body}")
        end
        if releases.size < 100
          complete = true
          break
        end
      end
      @entries.concat(found)
      gap("#{component} release pagination", "Stopped at 1000 releases; inspect older pages") unless complete
      gap("#{component} changelog", "No parsed entries; repository guides and commits still need review") if found.empty?
    rescue StandardError => error
      gap("#{component} remote notes", error)
    end

    def collect_defaults(directory, component, release)
      Dir.glob(File.join(directory, "**", "new_framework_defaults_*.rb.tt")).sort.each do |path|
        version = File.basename(path)[/defaults_(\d+_\d+)/, 1]&.tr("_", ".")
        next unless version && Gem::Version.new(version) <= @to
        current = []
        File.foreach(path).with_index(1) do |line, number|
          if line.match?(/\A#\s*(?:Rails\.application\.)?config\.\S+\s*=/)
            setting = line.sub(/\A#\s*(?:Rails\.application\.)?/, "").strip
            @defaults << { "version" => version, "setting" => setting, "note" => current.join.strip,
                           "source" => "https://rubygems.org/downloads/#{component}-#{release}.gem!#{path.delete_prefix(directory + '/')}:",
                           "path" => path, "line" => number }
            current = []
          elsif line.start_with?("#")
            current << line.delete_prefix("#").strip + " "
            current = [] if line.strip == "#"
          else
            current = []
          end
        end
      end
    end

    def collect_repository(name, from, to, versions, primary: false)
      url = (primary && @options[:repository]) || repository_url(metadata(name, to))
      return gap("#{name} repository", "No source repository in version metadata; locate upstream manually") unless url
      key = [url, from.to_s, to.to_s]
      return if @repository_ranges[key]
      repository = (@repositories[url] ||= Repository.new(@cache, url))
      from_ref = repository.tag(name, from, primary && @options[:from_ref])
      to_ref = repository.tag(name, to, primary && @options[:to_ref])
      refs = { from.to_s => from_ref, to.to_s => to_ref }
      versions.each do |version|
        refs[version.to_s] ||= repository.tag(name, version)
      rescue StandardError => error
        gap("#{name} #{version} guide tag", error)
      end
      repository.fetch(refs.values)
      @repository_ranges[key] = true
      first = repository.commit(from_ref)
      last = repository.commit(to_ref)
      prefix = File.join(@output, "repositories", Digest::SHA256.hexdigest(key.join('/'))[0, 12])
      FileUtils.mkdir_p(prefix)
      _, ancestor = Open3.capture2e("git", "-C", repository.directory, "merge-base", "--is-ancestor", first, last)
      gap("#{name} release ancestry", "Current tag is not an ancestor of target; review endpoint diff as well as target-only commits") unless ancestor.success?
      log = repository.git("log", "--reverse", "--format=%x1e%H%x00%B%x00", "--name-only", "#{first}..#{last}", "--")
      commits = log.split("\x1e").reject(&:empty?).map do |record|
        sha, message, paths = record.split("\0", 3)
        files = paths.to_s.lines.map(&:strip).reject(&:empty?)
        kinds = GemSources.kinds(message)
        kinds << "dependency" if files.any? { |path| path.end_with?(".gemspec") }
        runtime_files = files.reject { |path| path.match?(%r{(?:\A|/)(?:test|tests|spec|docs?|guides|\.github)/}) || path.match?(/\.(?:md|rdoc|txt|rst)\z/) }
        hits = GemSources.identifiers(message).flat_map { |identifier| @index.hits(identifier) }.uniq
        priority = runtime_files.any? && (message.match?(REMOVAL) || message.match?(DEPRECATION) || message.match?(/\bdefault\w*|\bcompatib\w*/i) || kinds.include?("dependency") || hits.any?)
        { "sha" => sha.strip, "message" => message.strip, "paths" => files, "kinds" => kinds.uniq, "priority" => priority,
          "url" => repository.source_url(sha.strip) }
      end
      small = commits.size <= @options.fetch(:small_limit, 80)
      record = { "repository" => url, "git_directory" => repository.directory, "from_tag" => from_ref,
                 "to_tag" => to_ref, "from_sha" => first, "to_sha" => last, "small" => small, "commits" => commits }
      UpgradeSupport.json(File.join(prefix, "commits.json"), record)
      File.write(File.join(prefix, "range.patch"), repository.git("diff", "--no-ext-diff", "--no-renames", first, last, "--"))
      commits.each do |commit|
        next unless small
        patch = File.join(prefix, "#{commit['sha']}.patch")
        File.write(patch, repository.git("show", "--format=fuller", "--first-parent", "--no-ext-diff", commit["sha"], "--"))
        commit["patch"] = patch.delete_prefix(@output + "/")
      end
      UpgradeSupport.json(File.join(prefix, "commits.json"), record)
      groups = small ? { "all commits" => commits } : commits.group_by { |commit| commit["paths"].first.to_s.split('/').first || "root" }
      groups.each do |group, items|
        text = ["Source: #{url}", "Exact tags: #{from_ref} (#{first}) to #{to_ref} (#{last}).",
                "#{commits.size} commits in the range. #{small ? 'Read every commit patch.' : 'Inspect the priority commits and changed runtime code. Other commits remain in the full index; record any unreviewed area.'}",
                "Full index: #{File.join(prefix, 'commits.json')}", "Endpoint diff: #{File.join(prefix, 'range.patch')}", ""]
        ordered = small ? items : items.select { |commit| commit["priority"] }
        text << "#{ordered.size} commits listed, #{items.size - ordered.size} lower-priority commits retained in the full index.\n"
        ordered.each do |commit|
          text << "- #{commit['sha'][0, 12]} [#{commit['kinds'].empty? ? 'other' : commit['kinds'].join(', ')}] #{commit['message'].lines.first.to_s.strip}"
          text << "  Patch: #{commit['patch']}" if small
        end
        text << "\nRead a full commit: `ruby ${CLAUDE_PLUGIN_ROOT}/bin/gem-changes show #{File.join(prefix, 'commits.json')} SHA`."
        page("commits", "#{name} #{from} to #{to}: #{group}", text.join("\n"), key: "#{key}/#{group}")
      end
      collect_guides(repository, refs, from, to)
    end

    def collect_guides(repository, refs, from, to)
      seen = Set.new
      # Prefer the latest explanation, but retain older sections that were
      # changed or deleted. Deduplicate sections, not just entire documents.
      refs.sort_by { |version, _| Gem::Version.new(version) }.reverse_each do |version, ref|
        next if Gem::Version.new(version) <= from
        sha = repository.commit(ref)
        paths = repository.git("ls-tree", "-r", "--name-only", sha).lines.map(&:strip).select do |path|
          File.basename(path).match?(/(?:upgrad|\Amigrat|breaking|release.?notes)/i) && path.match?(/\.(?:md|markdown|rdoc|txt|rst|adoc)\z/i)
        end
        paths.each do |path|
          # A versioned release-note filename can be ruled out mechanically.
          number = File.basename(path)[/\A(\d+[._]\d+).*release/i, 1]&.tr("_", ".")
          next if number && (Gem::Version.new(number) <= Gem::Version.new(from.segments.first(2).join('.')) || Gem::Version.new(number) > to)
          text = repository.git("show", "#{sha}:#{path}")
          digest = Digest::SHA256.hexdigest(text)
          raw = File.join(@output, "guides", "#{digest[0, 12]}-#{File.basename(path)}")
          FileUtils.mkdir_p(File.dirname(raw))
          File.write(raw, text)
          sections = GemSources.sections(text)
          versioned = sections.select { |section| section["heading"].match?(/(?:upgrad|migrat).*\d+\.\d+/i) }
          selected = if versioned.any?
                       versioned.select do |section|
                         numbers = section["heading"].scan(/\d+\.\d+(?:\.\d+)?/).map { |value| Gem::Version.new(value) }
                         target = numbers.max
                         target && target > from && target <= to
                       end
                     else
                       sections
                     end
          selected = selected.reject do |section|
            key = [path, Digest::SHA256.hexdigest(section["text"])]
            duplicate = seen.include?(key)
            seen << key
            duplicate
          end
          next if selected.empty?
          excerpt = selected.map { |section| "Source line #{section['line']}:\n\n#{section['text']}" }.join("\n")
          page("guide", "#{ref}: #{path}", "Source: #{repository.source_url(sha, path)}\n\nFull document: #{raw}\nIdentical sections at other sampled tags are omitted here.\n\n#{excerpt}", key: "#{repository.url}/#{path}/#{digest}")
        end
      end
    end

    def collect_dependencies
      before = UpgradeSupport::Lockfile.new(@options.fetch(:before))
      after = UpgradeSupport::Lockfile.new(@options.fetch(:after))
      loaded_before = @options[:runtime_before] ? UpgradeSupport.read_json(@options[:runtime_before]) : {}
      loaded_after = @options[:runtime_after] ? UpgradeSupport.read_json(@options[:runtime_after]) : {}
      primary_components = components(@gem, @to) | components(@gem, @from)
      @manifest["dependencies"] = before.changes(after)
      @manifest["dependencies"].each do |change|
        old = change["before"]
        new = change["after"]
        next if change["name"] == @gem
        if primary_components.include?(change["name"]) && old&.fetch("versions") == [@from.to_s] && new&.fetch("versions") == [@to.to_s]
          change["covered_by"] = "Primary gem's lockstep component sources"
          next
        end
        if !old && loaded_before[change["name"]]
          old = { "versions" => [loaded_before[change["name"]]], "source" => { "type" => "GEM" } }
          change["effective_before"] = old["versions"].first
          change["before_basis"] = "Observed in the baseline runtime, though absent from its lockfile"
        end
        if !new && loaded_after[change["name"]]
          new = { "versions" => [loaded_after[change["name"]]], "source" => { "type" => "GEM" } }
          change["effective_after"] = new["versions"].first
        end
        if !old || !new
          page("dependency", "#{change['name']}: #{old ? 'removed' : 'added'} dependency",
               "Required by: #{change['required_by'].join(', ')}.\n\n#{JSON.pretty_generate(change)}\n\nCheck loading, runtime usage and replacement; there is no two-version range for an addition or removal.")
          next
        end
        unless old["source"]["type"] == "GEM" && new["source"]["type"] == "GEM" && old["versions"].one? && new["versions"].one?
          gap("#{change['name']} dependency", "Git/path source or multiple versions; inspect the recorded source revisions manually")
          next
        end
        a = Gem::Version.new(old["versions"].first)
        b = Gem::Version.new(new["versions"].first)
        if b > a
          collect_gem(change["name"], a, b)
        elsif b < a
          gap("#{change['name']} dependency", "Downgrade #{a} to #{b}; review the reverse range manually")
        else
          page("dependency", "#{change['name']}: source, platform or requirement change", JSON.pretty_generate(change))
        end
      rescue StandardError => error
        gap("#{change['name']} dependency", error)
      end
      page("dependency", "Resolved dependency changes", JSON.pretty_generate(@manifest["dependencies"]))
    end

    def write_entries
      @entries.uniq! { |entry| entry.values_at("component", "version", "text") }
      @entries.each do |entry|
        entry["id"] = Digest::SHA256.hexdigest(entry.values_at("component", "version", "text").join('/'))[0, 12]
        entry["hits"] = entry["identifiers"].flat_map { |identifier| @index.hits(identifier) }.uniq
      end
      UpgradeSupport.json(File.join(@output, "entries.json"), @entries)
      @entries.group_by { |entry| [entry["component"], Gem::Version.new(entry["version"]).segments.first(2).join('.')] }.sort.each do |(component, series), entries|
        ordered = entries.sort_by { |entry| [entry["kinds"].include?("removal") ? 0 : entry["kinds"].include?("deprecation") ? 1 : entry["kinds"].any? ? 2 : 3, entry["hits"].empty? ? 1 : 0, Gem::Version.new(entry["version"])] }
        text = ["Read removals, deprecations and behavior changes even without a text match. Read the full cited entry before deciding applicability or repair.", ""]
        details = ["# #{component} #{series}: full changelog entries", ""]
        details_path = "details/#{component}-#{series}.md"
        ordered.each do |entry|
          detail_line = details.join("\n").count("\n") + 2
          details += ["## #{entry['id']} #{entry['version']}", "Source: #{entry['source']}:#{entry['line']}", "", entry["text"], "",
                      *entry["hits"].map { |hit| "- #{hit}" }, ""]
          next if entry["kinds"].empty? && entry["hits"].empty?
          summary = entry["text"].sub(/\A[*-]\s*/, "").split(/\n\n/).first.to_s.gsub(/\s+/, " ")
          text << "- #{entry['id']} #{entry['version']} [#{entry['kinds'].empty? ? 'matched, lower priority' : entry['kinds'].join(', ')}] #{summary[0, 240]}#{summary.size > 240 ? '...' : ''}"
          text << "  Full entry: #{details_path}:#{detail_line}. Text matches: #{entry['hits'].empty? ? 'none' : entry['hits'].first(2).join('; ')}"
        end
        FileUtils.mkdir_p(File.join(@output, "details"))
        File.write(File.join(@output, details_path), details.join("\n") + "\n")
        text << "\nAll #{entries.size} entries, including unmatched fixes and features: #{details_path}."
        page("changelog", "#{component} #{series} changelog", text.join("\n"))
      end
    end

    def write_defaults
      config = File.join(@app, "config", "application.rb")
      settings = File.file?(config) ? File.readlines(config).reject { |line| line.lstrip.start_with?("#") }.join : ""
      current = settings[/load_defaults\s+["']?(\d+\.\d+)/, 1]
      @defaults.uniq! { |item| item.values_at("version", "setting") }
      @defaults.reject! { |item| current && Gem::Version.new(item["version"]) <= Gem::Version.new(current) }
      @defaults.each do |item|
        key = item["setting"].split("=").first.strip.delete_prefix("config.")
        item["explicit"] = Dir.glob(File.join(@app, "config", "**", "*.rb")).flat_map do |path|
          File.readlines(path).each_with_index.filter_map do |line, index|
            "#{path.delete_prefix(@app + '/')}:#{index + 1}: #{line.strip}" if !line.lstrip.start_with?("#") && line.match?(/config\.#{Regexp.escape(key)}\s*=/)
          end
        end
      end
      UpgradeSupport.json(File.join(@output, "defaults.json"), @defaults)
      @defaults.group_by { |item| item["version"] }.sort.each do |version, defaults|
        text = ["Declared load_defaults: #{current || 'not found'}. Assignments below come from upstream templates, not runtime measurements.",
                "Determine effective values at boot. A retained load_defaults does not prevent unconditional behavior changes or removed options.", ""]
        defaults.each do |item|
          text += ["## #{item['setting']}", item["note"], "Source: #{item['source']}#{item['line']}",
                   "Explicit assignment: #{item['explicit'].empty? ? 'not found' : item['explicit'].join('; ')}", ""]
        end
        page("defaults", "#{version} framework defaults", text.join("\n"))
      end
    end

    def run
      collect_gem(@gem, @from, @to, primary: true) unless @options[:dependencies_only]
      collect_dependencies if @options[:before]
      write_entries
      write_defaults
      @manifest["entry_count"] = @entries.size
      @manifest["gaps"].uniq!
      UpgradeSupport.json(File.join(@output, "manifest.json"), @manifest)
      text = ["# #{@gem} #{@from} to #{@to}: source index", "",
              "Read in order: changelogs, commits, guides, defaults, moved dependencies. A match is a search hint, not a finding.",
              "Sampled releases: #{@manifest['versions'].join(', ')}. Entries: #{@entries.size}. Pages: #{@manifest['pages'].size}.",
              "Full manifest: #{File.join(@output, 'manifest.json')}", "", "## Pages", ""]
      @manifest["pages"].sort_by { |item| [%w[changelog commits guide release-notes remote-notes defaults dependency requirements].index(item["kind"]), item["title"]] }.each do |item|
        text << "- #{item['id']}: #{item['title']} (#{item['path']})"
      end
      text += ["", "## Coverage gaps", "", *@manifest["gaps"].map { |message| "- #{message}" }]
      File.write(File.join(@output, "index.md"), text.join("\n") + "\n")
      puts JSON.pretty_generate("index" => File.join(@output, "index.md"), "manifest" => File.join(@output, "manifest.json"),
                                "pages" => @manifest["pages"].size, "entries" => @entries.size, "gaps" => @manifest["gaps"])
      @manifest
    end
  end
end
