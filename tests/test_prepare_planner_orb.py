import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class PreparePlannerOrbTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.app = root / "repo"
        self.app.mkdir()
        self.inputs = root / "inputs"
        shutil.copytree(Path(__file__).with_name("planner-inputs"), self.inputs)
        self.plugin = root / "repos" / "claude-plugins" / "plugins" / "maintain-rails"
        self.git("init", "--quiet")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.com")
        (self.app / "fixture.txt").write_text("frozen application\n")
        self.git("add", "fixture.txt")
        self.git("commit", "--quiet", "-m", "Frozen fixture")
        self.commit = self.git("rev-parse", "HEAD").stdout.strip()
        manifest = json.loads((self.inputs / "manifest.json").read_text())
        manifest["application_commit"] = self.commit
        (self.inputs / "manifest.json").write_text(json.dumps(manifest))
        self.manifest = manifest

    def git(self, *args):
        return subprocess.run(
            ["git", "-C", str(self.app), *args],
            capture_output=True, text=True, check=True,
        )

    def generate(self):
        return subprocess.run(
            [sys.executable, "-B", str(Path(__file__).with_name("prepare-planner-orb.py")),
             "--inputs", str(self.inputs)],
            capture_output=True, text=True,
        )

    def install(self, script):
        return subprocess.run(
            ["bash"], input=script, cwd=self.app, capture_output=True, text=True,
        )

    def test_pins_application_and_reinstalls_only_frozen_runtime_bytes(self):
        (self.app / "fixture.txt").write_text("later application\n")
        self.git("commit", "--quiet", "-am", "Later fixture")
        (self.inputs / "answer-key.txt").write_text("DO NOT EMBED THIS ANSWER KEY")
        generated = self.generate()
        self.assertEqual(generated.returncode, 0, generated.stderr)
        self.assertNotIn("DO NOT EMBED", generated.stdout)
        syntax = subprocess.run(["bash", "-n"], input=generated.stdout, capture_output=True, text=True)
        self.assertEqual(syntax.returncode, 0, syntax.stderr)
        for _ in range(2):
            installed = self.install(generated.stdout)
            self.assertEqual(installed.returncode, 0, installed.stderr)
            self.assertEqual(self.git("rev-parse", "HEAD").stdout.strip(), self.commit)
            self.assertEqual((self.app / "fixture.txt").read_text(), "frozen application\n")
            self.assertEqual(self.git("status", "--porcelain").stdout, "")
            self.assertFalse((self.plugin.parent.parent / ".git").exists())
            files = {str(p.relative_to(self.plugin)) for p in self.plugin.rglob("*") if p.is_file()}
            self.assertEqual(files, set(self.manifest["files"]))
            for name, checksum in self.manifest["files"].items():
                self.assertEqual(hashlib.sha256((self.plugin / name).read_bytes()).hexdigest(), checksum)
            audit = json.loads((self.app / ".amp/planner-source.json").read_text())
            self.assertEqual(audit["application_commit"], self.commit)
            self.assertEqual(audit["input_manifest"], self.manifest)

    def test_refuses_dirty_application_or_existing_plugin_checkout(self):
        script = self.generate().stdout
        (self.app / "fixture.txt").write_text("uncommitted work\n")
        result = self.install(script)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.app / "fixture.txt").read_text(), "uncommitted work\n")
        self.assertFalse(self.plugin.exists())
        self.git("restore", "fixture.txt")
        checkout = self.plugin.parent.parent
        checkout.mkdir(parents=True)
        subprocess.run(["git", "init", "--quiet", str(checkout)], check=True)
        result = self.install(script)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((checkout / ".git").is_dir())
        self.assertFalse(self.plugin.exists())

    def test_refuses_to_overwrite_modified_installed_inputs(self):
        script = self.generate().stdout
        self.assertEqual(self.install(script).returncode, 0)
        prompt = self.plugin / "agents/gem-upgrade-planner.md"
        prompt.write_text("another experiment's prompt\n")
        result = self.install(script)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(prompt.read_text(), "another experiment's prompt\n")

    def test_rejects_corrupted_or_unapproved_inputs_before_emitting_setup(self):
        prompt = self.inputs / "maintain-rails/agents/gem-upgrade-planner.md"
        original = prompt.read_bytes()
        prompt.write_bytes(original + b"changed\n")
        result = self.generate()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        prompt.write_bytes(original)
        self.manifest["files"]["answer-key.txt"] = "0" * 64
        (self.inputs / "manifest.json").write_text(json.dumps(self.manifest))
        result = self.generate()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
