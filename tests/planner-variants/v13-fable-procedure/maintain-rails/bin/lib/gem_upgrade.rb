# frozen_string_literal: true

# Shared helpers for the maintain-rails scripts. Standard library only.

require "open3"

module GemUpgrade
  GEM_LINE = /\A(\s*gem\s+["']%s["'])((?:\s*,\s*["'][^"']*["'])*)(.*)\z/

  module_function

  # Returns the Gemfile text with GEM pinned to VERSION. The existing version
  # requirements after the gem name are replaced; other options are kept. A gem
  # the Gemfile does not list (a transitive dependency) is appended as a pin.
  def bump_gemfile(text, gem_name, version)
    pattern = Regexp.new(format(GEM_LINE.source, Regexp.escape(gem_name)))
    found = false
    lines = text.lines.map do |line|
      match = line.chomp.match(pattern)
      next line unless match && !line.lstrip.start_with?("#")

      found = true
      "#{match[1]}, \"#{version}\"#{match[3]}\n"
    end
    return lines.join if found

    text.chomp + "\n\n# Pinned for the upgrade experiment (transitive dependency).\ngem \"#{gem_name}\", \"#{version}\"\n"
  end

  # { "name" => "version" } for every gem in a Gemfile.lock.
  def lock_versions(text)
    text.scan(/^    ([\w.-]+) \(([^)\s]+)(?: [^)]*)?\)$/).to_h
  end

  # Gems whose version differs between two lockfiles: [name, old, new], where
  # old or new is nil for an added or removed gem.
  def lock_diff(old_text, new_text)
    old = lock_versions(old_text)
    new = lock_versions(new_text)
    (old.keys | new.keys).sort.filter_map do |name|
      [name, old[name], new[name]] unless old[name] == new[name]
    end
  end

  # One line per moved gem, flagging major version changes, new and removed
  # gems, and gems that replace one of Ruby's default gems.
  def lock_report_lines(diff)
    diff.map do |name, old, new|
      note = if old.nil?
               default = default_gem_version(name)
               "new dependency#{" (replaces Ruby's default gem #{default})" if default}"
             elsif new.nil? then "removed"
             elsif Gem::Version.new(old).segments.first != Gem::Version.new(new).segments.first then "MAJOR version change"
             end
      "- #{name}: #{old || "(absent)"} → #{new || "(removed)"}#{" — #{note}" if note}"
    end
  end

  # Version of a gem Ruby ships as a default gem, or nil.
  def default_gem_version(name)
    Gem::Specification.find_all_by_name(name).find(&:default_gem?)&.version&.to_s
  rescue Gem::LoadError
    nil
  end

  # Runs a command, returns [stdout+stderr, status]. Never raises.
  def capture(*command, chdir: nil, env: {}, stdin: nil)
    options = {}
    options[:chdir] = chdir if chdir
    options[:stdin_data] = stdin if stdin
    output, status = Open3.capture2e(env, *command, **options)
    [output, status]
  rescue SystemCallError => error
    [error.message, nil]
  end
end
