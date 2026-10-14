# frozen_string_literal: true

# Run through the copied application's Rails runner. Bundler can load a Ruby
# default library without registering it in Gem.loaded_specs, so also identify
# default libraries from Ruby's own file inventory and the observed load paths.
loaded_features = $LOADED_FEATURES.dup
loaded_versions = Gem.loaded_specs.transform_values { |spec| spec.version.to_s }
require "json"
require "rbconfig"

defaults = JSON.parse(File.read(ARGV.fetch(0)))
roots = RbConfig::CONFIG.values_at("rubylibdir", "archdir").compact.map { |path| path + "/" }
features = loaded_features.flat_map do |feature|
  roots.filter_map { |root| feature.delete_prefix(root) if feature.start_with?(root) }
end
versions = defaults.filter_map do |name, spec|
  [name, spec.fetch("version")] if (spec.fetch("files") & features).any?
end.to_h
versions.merge!(loaded_versions)
puts "UPGRADE_RUNTIME #{JSON.generate(versions)}"
puts "UPGRADE_BOOT_OK env=#{Rails.env} root=#{Rails.root}"
