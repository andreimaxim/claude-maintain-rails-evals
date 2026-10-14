# frozen_string_literal: true

# No test framework or network is needed. Exercise public commands with an
# unrelated fixture, including branches where a plausible shortcut is wrong.
require "digest"
require "fileutils"
require "json"
require "open3"
require "rbconfig"
require "rubygems/package"
require "tmpdir"

ROOT = File.expand_path("..", __dir__)
RUBY = RbConfig.ruby
$checks = 0

def assert(condition, message)
  raise message unless condition
  $checks += 1
end

def command(*args, env: {}, cwd: ROOT, status: 0)
  out, error, result = Open3.capture3(env, *args, chdir: cwd)
  assert(result.exitstatus == status, "#{args.join(' ')} exited #{result.exitstatus}, expected #{status}\n#{out}\n#{error}")
  out + error
end

def write(path, content)
  FileUtils.mkdir_p(File.dirname(path))
  File.write(path, content)
end

def json(path, content)
  write(path, JSON.pretty_generate(content))
end

def read_json(path)
  JSON.parse(File.read(path))
end

Dir.mktmpdir("upgrade-contract-") do |temporary|
  cache = File.join(temporary, "cache")
  upstream = File.join(temporary, "upstream")
  app = File.join(temporary, "app")
  env = { "GEM_CHANGES_CACHE" => cache }
  FileUtils.mkdir_p([upstream, app])
  command("git", "init", "--quiet", upstream)
  command("git", "-C", upstream, "config", "user.name", "Fixture")
  command("git", "-C", upstream, "config", "user.email", "fixture@example.invalid")

  notes = <<~NOTES
    # Unreleased
    * Remove `future_only`.
    # 1.2.0
    * Change `dispatch_value` to use a keyword.
    # 1.1.0
    * Remove `legacy_value`.
    * Fix `edge_value` when its argument is zero.
    # 1.0.0
    * Remove `before_the_range`.
  NOTES
  versions = %w[1.0.0 1.1.0 1.2.0]
  store = lambda { |url, body| write(File.join(cache, "http", Digest::SHA256.hexdigest(url)), body) }
  store.call("https://rubygems.org/api/v1/versions/sample_lib.json", JSON.generate(versions.map { |version| { "number" => version, "prerelease" => false } }))

  versions.each do |version|
    write(File.join(upstream, "lib", "sample_lib.rb"), "def dispatch_value(value#{version == '1.2.0' ? ':' : ''}); value; end\n")
    write(File.join(upstream, "CHANGELOG.md"), notes)
    templates = %w[1_0 1_1].map do |series|
      path = "lib/generators/templates/new_framework_defaults_#{series}.rb.tt"
      write(File.join(upstream, path), "# config.fixture_toggle_#{series} = true\n")
      path
    end
    write(File.join(upstream, "docs", "upgrading-guide.md"), <<~GUIDE)
      Upgrading from 1.1 to 1.2
      ------------------------
      A shared upgrade section appears only once in the review pages.
      ```text
      # Upgrading from 0.8 to 0.9
      A code block is not a version boundary.
      ```
      Upgrading from 0.9 to 1.0
      ------------------------
      This earlier upgrade is outside the requested range.
    GUIDE
    if version == "1.1.0"
      write(File.join(upstream, "docs", "UPGRADING.md"), "# Upgrade\nAn intermediate-only guide must remain available.\n")
    elsif version == "1.2.0"
      File.delete(File.join(upstream, "docs", "UPGRADING.md"))
      write(File.join(upstream, "docs", "UPGRADE.md"), "# Upgrade\nPass the value by keyword.\n")
    end
    command("git", "-C", upstream, "add", "--all")
    command("git", "-C", upstream, "commit", "--quiet", "-m", version == "1.0.0" ? "Initial library" : "Remove old dispatch form for #{version}")
    command("git", "-C", upstream, "tag", "v#{version}")
    # Generate a real gem archive with RubyGems, then seed the documented cache.
    spec = Gem::Specification.new do |item|
      item.name = "sample_lib"
      item.version = version
      item.authors = ["Fixture"]
      item.summary = "Offline command contract fixture"
      item.license = "MIT"
      item.files = %w[CHANGELOG.md lib/sample_lib.rb] + templates
    end
    package = File.join(temporary, "sample_lib-#{version}.gem")
    Dir.chdir(upstream) { Gem::Package.build(spec, true, false, package) }
    store.call("https://rubygems.org/downloads/sample_lib-#{version}.gem", File.binread(package))
    store.call("https://rubygems.org/api/v2/rubygems/sample_lib/versions/#{version}.json",
               JSON.generate("name" => "sample_lib", "number" => version, "ruby_version" => ">= 2.7", "dependencies" => { "runtime" => [] }))
  end

  write(File.join(app, "Gemfile"), "source 'https://rubygems.org'\ngem 'sample_lib', '1.0.0'\n")
  lock_text = "GEM\n  remote: https://rubygems.org/\n  specs:\n    sample_lib (1.0.0)\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  sample_lib (= 1.0.0)\n\nBUNDLED WITH\n   2.5.22\n"
  write(File.join(app, "Gemfile.lock"), lock_text)
  write(File.join(app, "app", "models", "sample.rb"), "service.dispatch_value(17)\n")
  write(File.join(app, "config", "application.rb"), "# Example only: config.load_defaults 1.2\nconfig.load_defaults 1.0\n")
  write(File.join(app, "config", "database.yml"), "default: &default\n  adapter: postgresql\ndevelopment:\n  <<: *default\ntest:\n  <<: *default\nproduction:\n  <<: *default\n")
  write(File.join(app, "config", "storage.yml"), "local:\n  service: Disk\n  root: /not/the/copy\n")
  command("git", "init", "--quiet", app)
  command("git", "-C", app, "add", "--all")
  command("git", "-C", app, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Fixture app")
  # A dirty tracked file and a nonignored new file must both reach the copy.
  write(File.join(app, "app", "models", "sample.rb"), "service.dispatch_value(31)\n")
  write(File.join(app, "untracked.txt"), "keep this input\n")

  evidence = File.join(temporary, "evidence")
  tool = File.join(ROOT, "bin", "gem-changes")
  command(RUBY, tool, "sample_lib", "1.0.0", "1.2.0", app, "--out", evidence, "--repository", upstream, env: env)
  manifest = read_json(File.join(evidence, "manifest.json"))
  assert(manifest["gaps"].empty?, "Unexpected source gap: #{manifest['gaps']}")
  assert(manifest["versions"] == %w[1.1.0 1.2.0], "Intermediate series disappeared")
  entries = read_json(File.join(evidence, "entries.json"))
  assert(entries.size == 3, "Release bounds or unreleased parsing is wrong")
  defaults = read_json(File.join(evidence, "defaults.json"))
  assert(defaults.map { |item| item["version"] } == ["1.1"], "A comment hid a new default, or an adopted default was repeated")
  assert(entries.find { |entry| entry["text"].include?("dispatch_value") }["hits"].any?, "Text match in copied app disappeared")
  assert(entries.find { |entry| entry["text"].include?("legacy_value") }["hits"].empty?, "Unmatched removal was assigned a false hit")
  guides = manifest["pages"].select { |page| page["kind"] == "guide" }.map { |page| File.read(File.join(evidence, page["path"])) }.join
  assert(guides.include?("intermediate-only"), "Guide removed before target was lost")
  assert(guides.scan("A shared upgrade section").size == 1, "Repeated guide section was not deduplicated")
  assert(!guides.include?("This earlier upgrade is outside"), "Underlined headings did not bound the requested versions")
  assert(guides.include?("A code block is not a version boundary"), "A code example was parsed as a guide heading")
  commits_file = Dir.glob(File.join(evidence, "repositories", "*", "commits.json")).fetch(0)
  commits = read_json(commits_file)
  assert(commits["small"] && commits["commits"].size == 2, "Wrong tag comparison")
  assert(commits["commits"].all? { |commit| File.file?(File.join(evidence, commit.fetch("patch"))) }, "A small-range commit has no patch")
  command(RUBY, tool, "show", commits_file, commits["commits"].last["sha"], env: env)
  command(RUBY, tool, "show", commits_file, "0" * 40, env: env, status: 2)
  command(RUBY, tool, "sample_lib", "1.2.0", "1.0.0", app, "--out", File.join(temporary, "backward"), env: env, status: 2)
  command(RUBY, tool, "sample_lib", "1.0.0", "1.2.0", app, "--out", File.join(app, "evidence"), env: env, status: 2)
  command(RUBY, tool, "sample_lib", "1.0.0", "1.2.0", app, "--out", File.join(temporary, "unsafe-cache"),
          env: { "GEM_CHANGES_CACHE" => File.join(app, "cache") }, status: 2)
  assert(!File.exist?(File.join(app, "cache")), "Cache guard wrote inside the application")

  # Missing tags must be visible, not quietly replaced by HEAD.
  missing = File.join(temporary, "missing-tag")
  command(RUBY, tool, "sample_lib", "1.0.0", "1.2.0", app, "--out", missing,
          "--repository", upstream, "--to-ref", "no-such-tag", env: env)
  assert(read_json(File.join(missing, "manifest.json"))["gaps"].any? { |gap| gap.include?("does not exist") }, "Missing tag did not produce a gap")

  # Force the large-range path without creating hundreds of artificial commits.
  large = File.join(temporary, "large")
  command(RUBY, tool, "sample_lib", "1.0.0", "1.2.0", app, "--out", large, "--repository", upstream, "--small-limit", "1", env: env)
  large_file = Dir.glob(File.join(large, "repositories", "*", "commits.json")).fetch(0)
  large_commits = read_json(large_file)
  assert(!large_commits["small"] && large_commits["commits"].size == 2, "Large-range index lost commits")
  patch = command(RUBY, tool, "show", large_file, large_commits["commits"].first["sha"][0, 12], env: env).strip
  assert(File.read(patch).include?("Remove old dispatch"), "Lazy patch retrieval did not return source")

  # A library absent from the old lockfile can still have been used at runtime.
  %w[5.0.0 6.0.0].each do |version|
    store.call("https://rubygems.org/api/v2/rubygems/root_lib/versions/#{version}.json",
               JSON.generate("name" => "root_lib", "number" => version, "dependencies" => { "runtime" => [] }))
  end
  old_lock = File.join(temporary, "before.lock")
  new_lock = File.join(temporary, "after.lock")
  runtime = File.join(temporary, "runtime.json")
  write(old_lock, "GEM\n  remote: https://rubygems.org/\n  specs:\n    root_lib (5.0.0)\n    removed_lib (1.0.0)\n\nDEPENDENCIES\n  root_lib\n")
  write(new_lock, "GEM\n  remote: https://rubygems.org/\n  specs:\n    root_lib (6.0.0)\n      sample_lib (>= 1.2.0)\n    sample_lib (1.2.0)\n\nDEPENDENCIES\n  root_lib\n")
  json(runtime, "sample_lib" => "1.0.0")
  moved = File.join(temporary, "moved")
  command(RUBY, tool, "root_lib", "5.0.0", "6.0.0", app, "--out", moved,
          "--before", old_lock, "--after", new_lock, "--runtime-before", runtime, "--dependencies-only", env: env)
  moves = read_json(File.join(moved, "manifest.json"))["dependencies"]
  dependency = moves.find { |item| item["name"] == "sample_lib" }
  assert(dependency["effective_before"] == "1.0.0" && dependency["required_by"] == ["root_lib"], "Effective version or dependency parent was lost")
  assert(read_json(File.join(moved, "entries.json")).size == 3, "Loaded default library did not receive range research")
  assert(moves.find { |item| item["name"] == "removed_lib" }["after"].nil?, "Removed dependency disappeared from the inventory")

  lab_tool = File.join(ROOT, "bin", "gem-upgrade-lab")
  lab = File.join(temporary, "lab")
  command(RUBY, lab_tool, "init", app, "sample_lib", "1.0.0", "1.2.0", lab)
  copy = File.join(lab, "variants", "baseline", "app")
  assert(File.read(File.join(copy, "app", "models", "sample.rb")).include?("31"), "Dirty tracked input was not copied")
  assert(File.read(File.join(copy, "untracked.txt")).include?("keep this"), "Untracked input was not copied")
  assert(File.read(File.join(copy, "config", "storage.yml")).include?(lab), "Storage is not inside the lab")
  databases = read_json(File.join(lab, "lab.json"))["variants"]["baseline"]["databases"].map { |database| database["name"] }
  assert(databases.uniq.size == 3 && databases.all? { |name| name.start_with?("gu_") }, "Environment databases are not independent")
  command(RUBY, lab_tool, "exec", lab, "baseline", "--", RUBY, "-e", "abort 'must not run'", status: 2)
  command(RUBY, lab_tool, "fork", lab, "baseline", "repair")
  repair_dbs = read_json(File.join(lab, "lab.json"))["variants"]["repair"]["databases"].map { |database| database["name"] }
  assert((databases & repair_dbs).empty?, "Fork reused another variant's database")
  command(RUBY, lab_tool, "init", app, "sample_lib", "0.9.0", "1.2.0", File.join(temporary, "wrong-version"), status: 2)
  command(RUBY, lab_tool, "init", app, "sample_lib", "1.0.0", "1.2.0", File.join(app, "unsafe"), status: 2)
  alias_path = File.join(temporary, "app-alias")
  File.symlink(app, alias_path)
  command(RUBY, lab_tool, "init", app, "sample_lib", "1.0.0", "1.2.0", File.join(alias_path, "unsafe"), status: 2)

  # An external symlink must be rejected before it can write through to source.
  File.symlink(File.join(upstream, "CHANGELOG.md"), File.join(app, "outside.md"))
  command(RUBY, lab_tool, "init", app, "sample_lib", "1.0.0", "1.2.0", File.join(temporary, "symlink-lab"), status: 2)
  File.delete(File.join(app, "outside.md"))
  File.symlink(upstream, File.join(copy, "outside-directory"))
  command(RUBY, lab_tool, "fork", lab, "baseline", "unsafe_fork", status: 2)
  File.delete(File.join(copy, "outside-directory"))
  command(RUBY, lab_tool, "status", lab)
  command(RUBY, lab_tool, "clean", lab)
  assert(read_json(File.join(lab, "lab.json"))["closed"], "Cleanup did not close the lab")

  report_tool = File.join(ROOT, "bin", "gem-upgrade-report")
  plan = File.join(temporary, "plan.json")
  command(RUBY, report_tool, "init", plan, File.join(evidence, "manifest.json"))
  command(RUBY, report_tool, "check", plan, status: 1)
  report = read_json(plan)
  report["summary"] = "A source-only fixture report; no application experiment was executed."
  report["limitations"] << "Runtime is deliberately unavailable in this offline test."
  report["coverage"].each { |row| row.merge!("status" => "unknown", "notes" => "Source collection was tested, but applicability has not been reviewed.") }
  report["default_decisions"].each do |row|
    row.merge!("current_value" => "Unmeasured.", "impact" => "Not evaluated by this source-only contract test.",
               "decision" => "No adoption proposed.", "evidence" => "Only the packaged template was collected.")
  end
  finding = read_json(File.join(temporary, "finding-template.json"))
  finding.merge!("title" => "Changed call contract", "app_locations" => ["app/models/sample.rb:1"],
                 "condition" => "The application calls the positional form.", "consequence" => "The call requires review against the target signature.",
                 "source_evidence" => [commits_file], "repair" => "Pass the value by keyword.", "other_paths" => "Retain the optional-argument path.",
                 "current_version_compatibility" => "Not executed.", "rollout_and_rollback" => "No persistent payloads were examined.",
                 "observations" => "Source-based proposal only.", "evidence_status" => "source_based")
  finding["validation"].merge!("data" => "Use 31 and a default value of 7.", "assertion_without_repair" => "The target rejects the positional call.",
                              "assertion_with_repair" => "The returned value is 31.", "unchanged_control" => "The omitted-argument path still returns 7.")
  report["findings"] << finding
  json(plan, report)
  command(RUBY, report_tool, "check", plan)
  rendered = command(RUBY, report_tool, "render", plan)
  assert(rendered.include?("source_based"), "Report output lost evidence status")
  assert(rendered.include?("Unchanged control: The omitted-argument path still returns 7."), "Control did not reach the rendered plan")
  decision = report["default_decisions"].pop
  json(plan, report)
  assert(command(RUBY, report_tool, "check", plan, status: 1).include?("Default decisions"), "An omitted default decision was accepted")
  report["default_decisions"] << decision
  report["findings"][0]["validation"]["unchanged_control"] = ""
  json(plan, report)
  error = command(RUBY, report_tool, "check", plan, status: 1)
  assert(error.include?("unchanged_control"), "A missing control was accepted")
  report["findings"][0]["validation"]["unchanged_control"] = "Still 7."
  report["findings"][0]["evidence_status"] = "executed"
  json(plan, report)
  assert(command(RUBY, report_tool, "check", plan, status: 1).include?("run records"), "Unsupported executed claim was accepted")
end

puts "#{$checks} command-contract assertions passed."
