#!/usr/bin/env bash
set -euo pipefail

# Run as the sample project's pre-setup script, before .agents/setup loads the plugin.
app_root="$(pwd)"
plugin_root="$app_root/../repos/claude-plugins"

pin_checkout() {
  local repository="$1" commit="$2"
  if [[ -n "$(git -C "$repository" status --porcelain --untracked-files=no)" ]]; then
    echo "Refusing to pin a checkout with tracked changes: $repository" >&2
    return 1
  fi
  if ! git -C "$repository" cat-file -e "$commit^{commit}" 2>/dev/null; then
    git -C "$repository" fetch --quiet --depth=1 origin "$commit"
  fi
  git -C "$repository" checkout --quiet --detach "$commit"
  [[ "$(git -C "$repository" rev-parse HEAD)" == "$commit" ]]
}

pin_checkout "$app_root" 9938031e54e1d7d074f1200a0da17e49390c86fa
pin_checkout "$plugin_root" 11b074b79a35be55d5768ba3799b1dff768dfb94

printf '%s  %s\n' \
  6fb8e6b1df27e475bdd97b3a55c93118c6b763339664812a7d18cce10908b71e \
  "$plugin_root/plugins/maintain-rails/agents/gem-upgrade-planner.md" \
  bf6aa50a5216265adc52fdd53428af037df779856d7c0d125dfdc288af4bd652 \
  "$plugin_root/plugins/maintain-rails/skills/upgrade-gem/SKILL.md" \
  | sha256sum --check --status

echo "Frozen application, plugin and prompt hashes verified."
