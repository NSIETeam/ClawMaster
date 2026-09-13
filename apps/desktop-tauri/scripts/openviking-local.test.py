"""Owner-only deployment and credential isolation checks; no network or model calls."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("openviking_local", Path(__file__).with_name("openviking-local.py"))
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)


@unittest.skipUnless(sys.platform == "darwin", "The deployment uses macOS permissions and launchd")
class DeploymentTests(unittest.TestCase):
    """Use independent temporary roots so each case owns all filesystem state."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="openviking-local-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.root.chmod(0o700)

    def put(self, name, value):
        path = self.root / name
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        HELPER.write_preserved(path, HELPER.json_bytes(value))
        return path

    def configured(self):
        credentials = self.put("credentials.yaml", {"refs": {"DEEPSEEK_API_KEY": "synthetic-deepseek-key"}})
        state = {"managedBy": HELPER.MANAGED, "serverVersion": HELPER.SERVER_VERSION,
                 "port": 1933, "model": "deepseek-flash", "credentialsFile": str(credentials)}
        self.put("deployment.json", state)
        self.put("config/ov.conf", HELPER.server_config(self.root, 1933, "deepseek-flash"))
        self.put("config/secrets.json", {"rootApiKey": "synthetic-root-token-with-at-least-32-chars"})
        for folder in ("data", "logs", "models"):
            (self.root / folder).mkdir(mode=0o700)
        HELPER.write_preserved(self.root / "models" / f"{HELPER.MODEL}.gguf", b"synthetic model")
        return state

    def test_existing_files_are_preserved_or_rejected(self):
        path = self.put("retained.json", {"setting": "user value"})
        original = path.read_bytes()
        HELPER.write_preserved(path, original)
        with self.assertRaisesRegex(ValueError, "differs"):
            HELPER.write_preserved(path, b"replacement")
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_symlink_cannot_replace_or_reveal_another_file(self):
        target = self.put("target.json", {"private": True})
        alias = self.root / "alias.json"
        alias.symlink_to(target)
        with self.assertRaises(ValueError):
            HELPER.read_private_json(alias)
        with self.assertRaises(ValueError):
            HELPER.write_preserved(alias, b"replacement")
        self.assertEqual(json.loads(target.read_text()), {"private": True})

    def test_world_readable_secret_is_rejected(self):
        path = self.put("secret.json", {"synthetic": True})
        path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "private"):
            HELPER.read_private_json(path)

    def test_unknown_existing_root_is_untouched(self):
        original = self.put("existing.json", {"untouched": True})
        args = argparse.Namespace(root=self.root)
        with self.assertRaisesRegex(ValueError, "unrecognized"):
            HELPER.prepare(args)
        self.assertEqual(list(self.root.iterdir()), [original])

    def test_external_bind_and_changed_data_paths_are_rejected(self):
        self.configured()
        config_path = self.root / "config/ov.conf"
        original = json.loads(config_path.read_text())
        for section, field, value in (("server", "host", "0.0.0.0"), ("storage", "workspace", "/tmp/foreign")):
            changed = json.loads(json.dumps(original))
            changed[section][field] = value
            config_path.write_bytes(HELPER.json_bytes(changed))
            with self.assertRaisesRegex(ValueError, "configuration differs"):
                HELPER.deployment(self.root)

    def test_corrupt_model_cannot_launch(self):
        self.configured()
        with self.assertRaisesRegex(ValueError, "model hash"):
            HELPER.deployment(self.root)

    def test_credentials_are_dynamic_and_stay_out_of_files(self):
        state = self.configured()
        before = (self.root / "config/ov.conf").read_bytes()
        incoming = {"PATH": "/test/bin", "UNRELATED_API_KEY": "discard", "OTHER_TOKEN": "discard"}
        with patch.object(HELPER, "model_hash", return_value=HELPER.MODEL_SHA256):
            first = HELPER.runtime_environment(self.root, incoming)
            self.assertEqual(first["DEEPSEEK_API_KEY"], "synthetic-deepseek-key")
            self.assertNotIn("UNRELATED_API_KEY", first)
            self.assertNotIn("OTHER_TOKEN", first)
            Path(state["credentialsFile"]).write_text(json.dumps({"refs": {"DEEPSEEK_API_KEY": "changed-synthetic-key"}}))
            second = HELPER.runtime_environment(self.root, incoming)
            self.assertEqual(second["DEEPSEEK_API_KEY"], "changed-synthetic-key")
        self.assertEqual((self.root / "config/ov.conf").read_bytes(), before)
        self.assertNotIn(b"synthetic-deepseek-key", before)
        self.assertIn(b"${DEEPSEEK_API_KEY}", before)
        self.assertEqual(incoming["OTHER_TOKEN"], "discard")

    def test_plist_contains_only_public_paths_and_foreground_runner(self):
        document = plistlib.loads(plistlib.dumps(HELPER.launchd_config(self.root)))
        self.assertEqual(document["Umask"], 0o077)
        self.assertNotIn("EnvironmentVariables", document)
        arguments = document["ProgramArguments"]
        self.assertEqual(arguments, [str(self.root / "venv/bin/python"), str(self.root / "openviking-local.py"),
                                     "serve", "--root", str(self.root)])
        self.assertTrue(str(document["StandardErrorPath"]).startswith(str(self.root / "logs")))

    def test_interrupted_package_install_resumes_without_recreating_venv(self):
        args = argparse.Namespace(uv="uv", python="python3", cache_dir=self.root / "cache")
        attempted_installs = 0
        created_environments = 0

        def command(argv, **_kwargs):
            nonlocal attempted_installs, created_environments
            if argv[1] == "venv":
                created_environments += 1
                (self.root / "venv").mkdir(mode=0o700)
            elif argv[1:3] == ["pip", "install"]:
                attempted_installs += 1
                if attempted_installs == 1:
                    raise subprocess.CalledProcessError(1, argv)

        with patch.object(HELPER.subprocess, "run", side_effect=command):
            with self.assertRaises(subprocess.CalledProcessError):
                HELPER.install_runtime(self.root, args)
            HELPER.install_runtime(self.root, args)
        self.assertEqual(created_environments, 1)
        self.assertEqual(attempted_installs, 2)

    def test_uncertain_provisioning_responses_recover_the_same_key(self):
        from openviking.server.api_keys.new import generate_api_key

        for interrupted_stage in ("account", "user", "client-file"):
            with self.subTest(interrupted_stage=interrupted_stage), tempfile.TemporaryDirectory(dir=self.root) as name:
                root = Path(name)
                (root / "config").mkdir(mode=0o700)
                HELPER.write_preserved(root / "config/secrets.json", HELPER.json_bytes({"rootApiKey": "synthetic-root-token-with-at-least-32-chars"}))
                registered = {}
                creations = []
                interrupted = False
                original_write = HELPER.write_preserved

                def request(_root, method, path, key=None, body=None):
                    nonlocal interrupted
                    if method == "GET":
                        role = "user" if path == "/api/v1/sessions" else "account"
                        if key != registered.get(role):
                            raise HELPER.ApiError(method, path, 401)
                        return []
                    role = "account" if path == "/api/v1/admin/accounts" else "user"
                    self.assertNotIn(role, registered, "Recovery must not recreate an existing identity")
                    user = "owner" if role == "account" else "watchdog"
                    registered[role] = generate_api_key("clawmaster", user, body["seed"])
                    creations.append(role)
                    if role == interrupted_stage and not interrupted:
                        interrupted = True
                        raise RuntimeError("Synthetic response lost after server commit")
                    return {"user_key": registered[role]}

                def write(path, data):
                    nonlocal interrupted
                    if path.name == "ovcli.conf" and interrupted_stage == "client-file" and not interrupted:
                        interrupted = True
                        raise OSError("Synthetic interruption before client credential persistence")
                    return original_write(path, data)

                with patch.object(HELPER, "deployment", return_value={"port": 1933}), patch.object(HELPER, "api", side_effect=request), patch.object(HELPER, "write_preserved", side_effect=write):
                    with self.assertRaises((RuntimeError, OSError)):
                        HELPER.provision(root)
                    HELPER.provision(root)
                client = HELPER.read_private_json(root / "config/ovcli.conf")
                self.assertEqual(client["api_key"], registered["user"])
                self.assertEqual(creations, ["account", "user"])


if __name__ == "__main__":
    unittest.main()
