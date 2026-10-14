# frozen_string_literal: true

# Run with ruby test/tools_test.rb. Uses only the Ruby standard library.
require "tmpdir"
require_relative "../bin/upgrade-support"

def assert(value, message)
  raise message unless value
end

Dir.mktmpdir("upgrade-tools-test-") do |root|
  before = File.join(root, "before.lock")
  after = File.join(root, "after.lock")
  File.write(before, <<~LOCK)
    GEM
      remote: https://rubygems.org/
      specs:
        engine (1.0.0)
          helper (>= 1)
        helper (1.5.0-x86_64-linux)
    GIT
      remote: https://example.org/source.git
      revision: old-revision
      specs:
        plugin (2.0.0)
          helper
    DEPENDENCIES
      engine
      plugin!
  LOCK
  File.write(after, File.read(before).sub("helper (1.5.0-x86_64-linux)", "helper (2.1.0-x86_64-linux)").sub("old-revision", "new-revision"))
  delta = UpgradeSupport.lock_delta(before, after)
  assert(delta.map { |row| row["name"] } == %w[helper plugin], "Lock delta must retain platform and source revision changes")
  assert(delta.first["required_by_after"] == %w[engine plugin], "Reverse dependencies must include an unconstrained dependency")
  assert(UpgradeSupport.lock_delta(before, before).empty?, "Identical locks are the negative control")
  missing = UpgradeSupport.upstream("sample", {}, Gem::Version.new("1"), Gem::Version.new("2"), [], File.join(root, "source"), root)
  assert(missing["status"] == "missing" && File.file?(File.join(root, "source/sources.json")), "Missing repository must be recorded, not silently ignored")

  evidence = File.join(root, "evidence")
  FileUtils.mkdir_p(evidence)
  UpgradeSupport.json(File.join(evidence, "entries.json"), [
    { id: "one", component: "sample", version: "2.0.1", title: "One", kinds: ["removal"], references: [] },
    { id: "two", component: "sample", version: "2.0.3", title: "Two", kinds: [], references: [] }
  ])
  UpgradeSupport.json(File.join(evidence, "defaults.json"), [])
  tool = File.expand_path("../bin/gem-upgrade-review", __dir__)
  output, status = Open3.capture2e(RbConfig.ruby, tool, "init", evidence)
  assert(status.success? && output.include?("1 candidates"), "Review should group a release series without dropping either entry")
  review_path = File.join(evidence, "review.json")
  review = JSON.parse(File.read(review_path))
  assert(File.read(review["candidates"].first["source"]).lines.size == 2, "Both entries must remain in the group index")
  _, status = Open3.capture2e(RbConfig.ruby, tool, "init", evidence)
  assert(!status.success?, "Initialization must not overwrite decisions")
  _, status = Open3.capture2e(RbConfig.ruby, tool, "check", evidence)
  assert(!status.success?, "Pending review must fail closure")
  review["candidates"].first.merge!({ "status" => "unverified", "reason" => "Synthetic test only" })
  review["source_review"] = ["Synthetic source coverage"]
  review["limits"] = ["No application finding was assessed by this fixture"]
  UpgradeSupport.json(review_path, review)
  _, status = Open3.capture2e(RbConfig.ruby, tool, "check", evidence)
  assert(status.success?, "Honest unresolved evidence with an explicit limit must be allowed")
  candidates = review["candidates"]
  review["candidates"] = []
  UpgradeSupport.json(review_path, review)
  output, status = Open3.capture2e(RbConfig.ruby, tool, "check", evidence)
  assert(!status.success? && output.include?("candidate removed"), "Dropping a candidate must not bypass closure")
  review["candidates"] = candidates
  review["findings"] = [{ "id" => "f1", "category" => "required" }]
  UpgradeSupport.json(review_path, review)
  output, status = Open3.capture2e(RbConfig.ruby, tool, "check", evidence)
  assert(!status.success? && output.include?("missing control"), "An incomplete finding must not pass closure")
end
puts "PASS: lock identity and reverse dependencies, explicit source gaps, complete group indexes, review non-overwrite and closure controls"
