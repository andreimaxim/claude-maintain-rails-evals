require "test_helper"
require "minitest/mock"

class SidekiqEnqueueTest < ActiveSupport::TestCase
  test "a digest job's arguments are native JSON through the Sidekiq adapter" do
    Sidekiq.redis { |r| r.del("digest_requests:2026-10-08") }
    DigestJob.queue_adapter = :sidekiq
    travel_to(Time.utc(2026, 10, 8, 12)) { assert users(:reader).request_digest }
    job = Sidekiq::Queues["default"].sole
    assert_equal "DigestJob", job["wrapped"]
    assert_kind_of String, job["args"].first["arguments"].last
  ensure
    DigestJob.queue_adapter = :test
    Sidekiq::Queues.clear_all
  end

  test "an export is removed when Redis refuses its job" do
    notebook = notebooks(:novels)
    ExportJob.stub(:perform_async, ->(*) { raise RedisClient::CannotConnectError }) do
      assert_no_difference(-> { Export.count }) do
        assert_raises(RedisClient::CannotConnectError) { notebook.request_export }
      end
    end
  end
end
