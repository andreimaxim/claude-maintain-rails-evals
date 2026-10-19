#!/usr/bin/env bash
# Retrieve only runtime inputs from one published evals revision in a fresh app orb.
set -euo pipefail
revision="${1:?full evals commit required}"
variant="${2:?original or v21 required}"
model="${3:?model required}"
effort="${4:?effort required}"
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid commit'; exit 1; }
case "$variant" in
  original) source='tests/planner-inputs/maintain-rails' ;;
  v21) source='tests/planner-variants/v21-resolve-deps/maintain-rails' ;;
  *) echo 'Invalid variant'; exit 1 ;;
esac
stage="$PWD/.git/amp-inputs"
mkdir -p "$stage" .amp/plugins
for path in scripts/prepare-amp-run.ts scripts/files.ts tests/amp-runtime/index.ts \
  "$source/agents/gem-upgrade-planner.md" "$source/skills/upgrade-gem/SKILL.md"; do
  mkdir -p "$stage/$(dirname "$path")"
  curl --fail --silent --show-error --retry 3 \
    "https://raw.githubusercontent.com/andreimaxim/claude-maintain-rails-evals/$revision/$path" -o "$stage/$path"
done
node "$stage/scripts/prepare-amp-run.ts" .git/amp-payload.tar.gz \
  --model "$model" --effort "$effort" --variant "$variant"
tar -xzf .git/amp-payload.tar.gz -C .amp/plugins
