# frozen_string_literal: true

# Run only on a fresh, reviewed lab whose baseline is expected to pass.
# This checks the public experiment/report commands, not upgrade applicability.
require "digest"
require "json"
require "open3"
require "rbconfig"

ROOT = File.expand_path("..", __dir__)
RUBY = RbConfig.ruby
LAB, *MANIFESTS = ARGV
abort "Usage: ruby test/application_smoke.rb REVIEWED_LAB MANIFEST.json [MANIFEST.json...]" unless LAB && MANIFESTS.any?
$checks = 0

def assert(condition, message)
  raise message unless condition
  $checks += 1
end

def command(tool, *args, env: {}, status: 0)
  output, errors, result = Open3.capture3(env, RUBY, File.join(ROOT, "bin", tool), *args, chdir: ROOT)
  assert(result.exitstatus == status, "#{tool} #{args.join(' ')} exited #{result.exitstatus}, expected #{status}\n#{output}\n#{errors}")
  output + errors
end

def state
  JSON.parse(File.read(File.join(LAB, "lab.json")))
end

def last_record(label)
  JSON.parse(File.read(state.fetch("variants").fetch(label).fetch("runs").last))
end

def probe(label, code, env: {}, status: 0)
  command("gem-upgrade-lab", "exec", LAB, label, "--", "ruby", "-e", code, env: env, status: status)
  last_record(label)
end

assert(state["review"], "Review the application's actual service configuration before this test")
command("gem-upgrade-lab", "check", LAB, "baseline")
baseline_tests = last_record("baseline")
assert(baseline_tests["stage"] == "tests" && baseline_tests["success"], "Baseline test suite did not run successfully")
command("gem-upgrade-lab", "fork", LAB, "baseline", "contract_probe")
before = state["variants"]["baseline"]
fork = state["variants"]["contract_probe"]
assert((before["databases"].map { |item| item["name"] } & fork["databases"].map { |item| item["name"] }).empty?, "Fork reused a baseline database")
command("gem-upgrade-lab", "check", LAB, "contract_probe")

redis_client = <<~RUBY
  require 'socket'
  require 'uri'
  uri = URI(ENV.fetch('REDIS_URL'))
  abort 'Redis is not private' unless uri.host == '127.0.0.1' && uri.port != 6379
  abort 'Unexpected inherited environment' if ENV.key?('GEM_UPGRADE_NO_LEAK')
  socket = TCPSocket.new(uri.host, uri.port)
RUBY
set = "socket.write(\"SET upgrade_contract_value 31\\r\\n\"); abort 'SET failed' unless socket.gets == \"+OK\\r\\n\"; puts 'PRIVATE_REDIS_WRITE_OK'"
get = "socket.write(\"GET upgrade_contract_value\\r\\n\"); abort 'Value lost' unless socket.gets == \"$2\\r\\n\" && socket.read(4) == \"31\\r\\n\"; puts 'PRIVATE_REDIS_PERSISTENCE_OK'"
empty = "socket.write(\"GET upgrade_contract_value\\r\\n\"); abort 'Cross-variant leak' unless socket.gets == \"$-1\\r\\n\"; puts 'PRIVATE_REDIS_SEPARATION_OK'"
probe("baseline", redis_client + set, env: { "GEM_UPGRADE_NO_LEAK" => "sentinel-not-a-secret" })
probe("contract_probe", redis_client + empty)
probe("baseline", redis_client + get)

%w[baseline contract_probe].each do |label|
  item = state["variants"][label]
  code = <<~RUBY
    expected = #{item['databases'].map { |database| database['name'] }.inspect}
    actual = ActiveRecord::Base.connection.select_value('SELECT current_database()')
    abort 'Connected outside the lab' unless expected.include?(actual)
    abort 'Not running in the copy' unless Rails.root.to_s == #{item['path'].inspect}
    puts 'PRIVATE_POSTGRESQL_AND_COPY_OK'
  RUBY
  command("gem-upgrade-lab", "exec", LAB, label, "--", "bin/rails", "runner", code)
end

failure = probe("baseline", "warn 'EXPECTED_PROBE_FAILURE'; exit 17", status: 1)
assert(failure["exit_status"] == 17 && failure["success"] == false, "Nonzero status was hidden")
timeout = probe("baseline", "sleep 10", env: { "GEM_UPGRADE_TIMEOUT" => "1" }, status: 1)
assert(timeout["timed_out"] && timeout["success"] == false, "Timeout was hidden")
command("gem-upgrade-lab", "status", LAB)

# Successful resolution must retain both the old lockfile and the new one.
records = state["variants"].values.flat_map { |item| item["runs"] }
resolutions = records.map { |path| JSON.parse(File.read(path)) }.select { |run| run["stage"] == "resolve" && run["success"] }
assert(resolutions.any?, "Run a bump or sweep before this smoke test")
resolutions.each do |record|
  assert(Digest::SHA256.file(record.fetch("lock")).hexdigest == record["lock_sha256"], "Resolved lockfile does not match its record")
  assert(record["lock_sha256"] != record["before_lock_sha256"], "Upgrade resolution lost its before/after lockfile difference")
end

plan_path = File.join(LAB, "validation-plan.json")
command("gem-upgrade-report", "init", plan_path, *MANIFESTS)
command("gem-upgrade-report", "check", plan_path, status: 1)
report = JSON.parse(File.read(plan_path))
report["summary"] = "Script validation only. This is not an application upgrade plan or an applicability review."
report["limitations"] << "Application findings, repairs and default adoption were not evaluated by this script smoke test."
report["coverage"].each do |row|
  row.merge!("status" => "unknown", "notes" => "Source artifact exists; application applicability was not reviewed by the smoke test.")
end
report["default_decisions"].each do |row|
  row.merge!("current_value" => "Not measured by this smoke test.", "impact" => "Not evaluated.",
             "decision" => "No adoption proposed.", "evidence" => "Template inventory only; no default-setting experiment.")
end
report["experiments"] = records
File.write(plan_path, JSON.pretty_generate(report) + "\n")
command("gem-upgrade-report", "check", plan_path)
rendered = command("gem-upgrade-report", "render", plan_path)
assert(rendered.include?("failed or timed out"), "Report concealed the negative controls")
assert(rendered.include?("Limits and unresolved checks") && rendered.include?("applicability was not reviewed"), "Report concealed unknown coverage")
File.write(File.join(LAB, "validation-plan.md"), rendered)

invalid_path = File.join(LAB, "validation-negative.json")
report["experiments"] << File.join(LAB, "nonexistent-run.json")
File.write(invalid_path, JSON.pretty_generate(report) + "\n")
assert(command("gem-upgrade-report", "check", invalid_path, status: 1).include?("missing run record"), "Report accepted an invented experiment")

summary = {
  "assertions" => $checks, "result" => "passed", "lab" => LAB,
  "baseline_test_summary" => File.readlines(baseline_tests["log"]).last(2).join.strip,
  "resolutions_with_before_and_after_locks" => resolutions.size,
  "checks" => ["baseline and fork suite", "private PostgreSQL connections", "private Redis separation and persistence",
               "environment allowlist", "nonzero exit and timeout", "real run artifacts in report", "unknown coverage visible", "invented run rejected"]
}
File.write(File.join(LAB, "script-smoke.json"), JSON.pretty_generate(summary) + "\n")
puts JSON.pretty_generate(summary)
