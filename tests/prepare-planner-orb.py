#!/usr/bin/env python3
"""Emit a self-contained pre-setup script from the eval-owned planner inputs.

Generating this script changes no project settings and makes no network requests.
Only the four runtime input files are embedded, never the evaluation answer keys.
"""

import argparse
import base64
import hashlib
import json
from pathlib import Path
import re


RUNTIME_FILES = {
    ".claude-plugin/plugin.json",
    "agents/gem-upgrade-planner.md",
    "skills/upgrade-gem/SKILL.md",
    "LICENSE",
}

PRE_SETUP = """#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PLANNER_EVAL_SETUP'
import base64
import hashlib
import json
from pathlib import Path
import subprocess

bundle = __BUNDLE__
manifest = bundle['manifest']
app = Path.cwd()
bootstrap = app.parent / 'repos' / 'claude-plugins'
plugin = bootstrap / 'plugins' / 'maintain-rails'

# This path is a bridge for the frozen app's setup, not a plugin Git checkout.
if bootstrap.is_symlink() or (bootstrap / '.git').exists():
    raise SystemExit('Refusing to replace a plugin checkout. Launch with no additional repositories.')
for parent in [bootstrap / 'plugins', plugin]:
    if parent.is_symlink():
        raise SystemExit('Refusing a symlinked plugin destination.')
if plugin.exists():
    existing = {str(p.relative_to(plugin)) for p in plugin.rglob('*') if p.is_file() or p.is_symlink()}
    if existing - set(manifest['files']):
        raise SystemExit('Refusing unexpected files in the plugin destination.')
for name, expected in manifest['files'].items():
    target = plugin / name
    if target.is_symlink() or any(p.is_symlink() for p in target.parents if p != plugin):
        raise SystemExit('Refusing a symlinked runtime input.')
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() != expected:
        raise SystemExit('Refusing to overwrite a modified runtime input: ' + name)

def git(*args):
    return subprocess.check_output(['git', '-C', str(app), *args], text=True).strip()

if git('status', '--porcelain', '--untracked-files=no'):
    raise SystemExit('Refusing to pin an application with tracked changes.')
commit = manifest['application_commit']
if subprocess.run(['git', '-C', str(app), 'cat-file', '-e', commit + '^{commit}'],
                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
    subprocess.run(['git', '-C', str(app), 'fetch', '--quiet', '--depth=1', 'origin', commit], check=True)
subprocess.run(['git', '-C', str(app), 'checkout', '--quiet', '--detach', commit], check=True)
if git('rev-parse', 'HEAD') != commit:
    raise SystemExit('Application revision does not match the input manifest.')

for name, encoded in bundle['contents'].items():
    data = base64.b64decode(encoded, validate=True)
    if hashlib.sha256(data).hexdigest() != manifest['files'][name]:
        raise SystemExit('Runtime input checksum mismatch: ' + name)
    target = plugin / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)

audit = app / '.amp' / 'planner-source.json'
audit.parent.mkdir(parents=True, exist_ok=True)
audit.write_text(json.dumps({
    'application_commit': git('rev-parse', 'HEAD'),
    'input_manifest': manifest,
    'installed_plugin_path': str(plugin),
    'transport': 'Embedded eval-owned files; no plugin repository cloned or fetched',
}, indent=2) + '\\n')
exclude = Path(git('rev-parse', '--git-path', 'info/exclude'))
if not exclude.is_absolute():
    exclude = app / exclude
if '.amp/planner-source.json' not in exclude.read_text().splitlines():
    with exclude.open('a') as output:
        output.write('\\n.amp/planner-source.json\\n')
print('Frozen application and eval-owned planner inputs verified.')
PLANNER_EVAL_SETUP
"""


def build(inputs):
    manifest = json.loads((inputs / "manifest.json").read_text())
    if set(manifest["files"]) != RUNTIME_FILES:
        raise ValueError("The runtime bundle must contain exactly the four approved files")
    if not re.fullmatch(r"[0-9a-f]{40}", manifest["application_commit"]):
        raise ValueError("The application must be pinned to a full commit hash")
    contents = {}
    for name, expected in manifest["files"].items():
        data = (inputs / "maintain-rails" / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("Input checksum mismatch: " + name)
        contents[name] = base64.b64encode(data).decode()
    return PRE_SETUP.replace("__BUNDLE__", repr({"manifest": manifest, "contents": contents}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, default=Path(__file__).parent / "planner-inputs")
    args = parser.parse_args()
    print(build(args.inputs), end="")
