# frozen_string_literal: true

require "digest"
require "fileutils"
require "find"
require "json"
require "open3"
require "pathname"
require "rbconfig"
require "rubygems"
require "securerandom"
require "time"
require "timeout"

module UpgradeSupport
  class Error < StandardError; end

  def self.json(path, value)
    FileUtils.mkdir_p(File.dirname(path))
    temporary = "#{path}.#{Process.pid}.tmp"
    File.write(temporary, JSON.pretty_generate(value) + "\n")
    File.rename(temporary, path)
  end

  def self.read_json(path)
    JSON.parse(File.read(path))
  end

  def self.capture(*command, chdir: nil)
    options = {}
    options[:chdir] = chdir if chdir
    output, errors, status = Open3.capture3({ "GIT_TERMINAL_PROMPT" => "0" }, *command, **options)
    raise Error, "#{command.first} failed (#{status.exitstatus}): #{(output + errors).lines.last(8).join}" unless status.success?

    output
  end

  def self.inside?(path, parent)
    path = File.expand_path(path)
    parent = File.expand_path(parent)
    path == parent || path.start_with?(parent + File::SEPARATOR)
  end

  def self.external_output!(path, app)
    ancestor = File.expand_path(path)
    ancestor = File.dirname(ancestor) until File.exist?(ancestor)
    raise Error, "Output must be outside the application" if inside?(path, app) || inside?(File.realpath(ancestor), app)
  end

  def self.name!(name)
    raise Error, "Invalid name: #{name.inspect}" unless name.to_s.match?(/\A[a-zA-Z0-9][a-zA-Z0-9_.-]*\z/)

    name
  end

  def self.version!(text)
    raise Error, "An exact version is required" unless text.to_s.match?(/\A\d[0-9a-zA-Z.]*\z/)

    Gem::Version.new(text)
  end

  # Read the lockfile without evaluating its Gemfile or loading application gems.
  class Lockfile
    attr_reader :specs, :direct, :bundler

    def initialize(path)
      @specs = {}
      @direct = []
      section = nil
      source = {}
      current = nil
      File.foreach(path) do |line|
        if line.match?(/\A[A-Z][A-Z ]*\n?\z/)
          section = line.strip
          source = { "type" => section }
          current = nil
        elsif %w[GEM GIT PATH].include?(section)
          if (match = line.match(/\A  (remote|revision|branch|ref): (.+)/))
            source[match[1]] = match[2]
          elsif (match = line.match(/\A    ([\w.-]+) \(([^)]+)\)/))
            name, raw = match.captures
            version, platform = raw.split("-", 2)
            current = (@specs[name] ||= { "versions" => [], "platforms" => [], "dependencies" => [], "source" => source.dup })
            current["versions"] |= [version]
            current["platforms"] |= [platform || "ruby"]
          elsif current && (match = line.match(/\A      ([\w.-]+)(?: \(([^)]+)\))?/))
            current["dependencies"] |= [{ "name" => match[1], "requirement" => match[2] || ">= 0" }]
          end
        elsif section == "DEPENDENCIES" && (match = line.match(/\A  ([\w.-]+)/))
          @direct << match[1]
        elsif section == "BUNDLED WITH" && line.strip.match?(/\A\d/)
          @bundler = line.strip
        end
      end
    end

    def version(name)
      versions = @specs.fetch(name) { raise Error, "#{name} is not in the lockfile" }.fetch("versions")
      raise Error, "#{name} has several locked versions: #{versions.join(', ')}" unless versions.one?

      versions.first
    end

    def changes(other)
      (@specs.keys | other.specs.keys).sort.filter_map do |name|
        before = @specs[name]
        after = other.specs[name]
        next if before == after

        {
          "name" => name, "before" => before, "after" => after,
          "direct" => (@direct | other.direct).include?(name),
          "required_by" => other.specs.select { |_, spec| spec["dependencies"].any? { |dependency| dependency["name"] == name } }.keys.sort
        }
      end
    end
  end

  # A subprocess result is an artifact, including failures and timeouts. Callers
  # must inspect success rather than hide a failing command behind a later tail.
  def self.run(command, directory:, env:, log:, timeout: 300)
    started = Time.now
    timed_out = false
    status = nil
    FileUtils.mkdir_p(File.dirname(log))
    File.open(log, "w", 0o600) do |output|
      pid = Process.spawn(env, *command, chdir: directory, out: output, err: output,
                         unsetenv_others: true, pgroup: true)
      begin
        Timeout.timeout(timeout) { _, status = Process.wait2(pid) }
      rescue Timeout::Error
        timed_out = true
        Process.kill("TERM", -pid) rescue Errno::ESRCH
        begin
          Timeout.timeout(3) { _, status = Process.wait2(pid) }
        rescue Timeout::Error
          Process.kill("KILL", -pid) rescue Errno::ESRCH
          _, status = Process.wait2(pid)
        end
      end
    end
    {
      "command" => command, "directory" => directory, "started_at" => started.utc.iso8601,
      "seconds" => (Time.now - started).round(2), "exit_status" => status&.exitstatus,
      "signal" => status&.termsig, "timed_out" => timed_out,
      "success" => !timed_out && status&.success?, "log" => log
    }
  end

  def self.file_hashes(directory)
    result = {}
    Find.find(directory) do |path|
      next if path == directory
      relative = path.delete_prefix(directory + "/")
      raise Error, "Symlink in experiment: #{relative}" if File.symlink?(path)
      if %w[.git .bundle tmp log storage node_modules].include?(File.basename(path))
        Find.prune if File.directory?(path)
        next
      end
      next unless File.file?(path)

      result[relative] = Digest::SHA256.file(path).hexdigest
    end
    result.sort.to_h
  end
end
