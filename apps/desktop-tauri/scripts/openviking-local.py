"""Prepare a private macOS OpenViking service outside the desktop application.

Preparation preserves existing files and writes a launchd draft without loading it.
The runner reads DSH credentials at each start; only environment references enter
the server configuration. Provisioning creates a dedicated tenant USER key through
the official HTTP API. Neither command changes DSH profiles or ~/.openviking.
"""

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import secrets
import shutil
import stat
import subprocess
import sys
import urllib.error
import urllib.request

SERVER_VERSION = "0.4.19"
LLAMA_VERSION = "0.3.35"
MODEL = "bge-small-zh-v1.5-f16"
MODEL_SHA256 = "ab9b81d9cd329c712eee379cf0068eabe6a5e2a01d0def61535eba9384085e2c"
MODEL_URL = "https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-f16.gguf?download=true"
LABEL = "com.clawmaster.openviking"
MANAGED = "clawmaster-openviking-local-v1"


def private_path(path, directory=False):
    """Reject links, foreign owners, and group/world access before reading state."""
    info = path.lstat()
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError(f"Expected a private owned {'directory' if directory else 'file'}: {path}")


def read_private_json(path):
    """Read owner-only JSON without permitting a symlink at the file."""
    private_path(path)
    return json.loads(path.read_text())


def write_preserved(path, data):
    """Create an owner-only file, or verify identical existing bytes without writing."""
    if path.exists() or path.is_symlink():
        private_path(path)
        if path.read_bytes() != data:
            raise ValueError(f"Existing managed file differs; preserve and review it before updating: {path}")
        return
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as target:
        target.write(data)


def json_bytes(value):
    """Encode stable configuration bytes without consulting credentials."""
    return (json.dumps(value, indent=2) + "\n").encode()


def model_hash(path):
    """Hash model bytes incrementally for installation and launch verification."""
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def clean_environment(source):
    """Keep ordinary process settings while removing inherited credentials."""
    return {key: value for key, value in source.items()
            if not any(part in key.upper() for part in ("KEY", "TOKEN", "SECRET", "PASSWORD"))}


def server_config(root, port, model):
    """Use loopback, local storage, a local embedder, and environment credentials."""
    return {
        "server": {"host": "127.0.0.1", "port": port, "auth_mode": "api_key",
                   "root_api_key": "${OPENVIKING_ROOT_API_KEY}"},
        "storage": {"workspace": str(root / "data"), "agfs": {"backend": "local"},
                    "vectordb": {"backend": "local"}},
        "embedding": {"dense": {"provider": "local", "model": MODEL, "dimension": 512,
                                "input": "text", "model_path": str(root / "models" / f"{MODEL}.gguf")},
                      "max_concurrent": 1},
        "vlm": {"provider": "litellm", "model": f"deepseek/{model}",
                "api_base": "https://api.deepseek.com", "api_key": "${DEEPSEEK_API_KEY}",
                "max_concurrent": 2, "max_retries": 1, "timeout": 120, "thinking": False},
    }


def launchd_config(root):
    """Return a credential-free launchd job that owns the foreground server."""
    return {
        "Label": LABEL,
        "ProgramArguments": [str(root / "venv/bin/python"), str(root / "openviking-local.py"),
                             "serve", "--root", str(root)],
        "WorkingDirectory": str(root), "RunAtLoad": True, "KeepAlive": True,
        "ThrottleInterval": 30, "ProcessType": "Background", "Umask": 0o077,
        "StandardOutPath": str(root / "logs/server.stdout.log"),
        "StandardErrorPath": str(root / "logs/server.stderr.log"),
    }


def deployment(root):
    """Validate the owned deployment and its network/data configuration."""
    private_path(root, directory=True)
    state = read_private_json(root / "deployment.json")
    if state.get("managedBy") != MANAGED or state.get("serverVersion") != SERVER_VERSION:
        raise ValueError(f"Unknown OpenViking deployment: {root}")
    actual = read_private_json(root / "config/ov.conf")
    if actual != server_config(root, state["port"], state["model"]):
        raise ValueError("The managed server configuration differs; review it before launching")
    for folder in ("config", "data", "logs", "models"):
        private_path(root / folder, directory=True)
    model = root / "models" / f"{MODEL}.gguf"
    private_path(model)
    if model_hash(model) != MODEL_SHA256:
        raise ValueError("The local embedding model hash differs from the pinned model")
    return state


def runtime_environment(root, source=None):
    """Resolve DSH and server credentials without persisting or printing their values."""
    import yaml

    state = deployment(root)
    credential_path = Path(state["credentialsFile"])
    private_path(credential_path)
    document = yaml.safe_load(credential_path.read_text())
    deepseek_key = document.get("refs", {}).get("DEEPSEEK_API_KEY")
    root_key = read_private_json(root / "config/secrets.json").get("rootApiKey")
    if not isinstance(deepseek_key, str) or not deepseek_key:
        raise ValueError("The existing DSH DEEPSEEK_API_KEY is unavailable")
    if not isinstance(root_key, str) or len(root_key) < 32:
        raise ValueError("The managed OpenViking root token is unavailable")
    env = clean_environment(os.environ if source is None else source)
    env.update({"DEEPSEEK_API_KEY": deepseek_key, "OPENVIKING_ROOT_API_KEY": root_key,
                "OPENVIKING_CONFIG_FILE": str(root / "config/ov.conf"), "PYTHONUNBUFFERED": "1"})
    return env


def install_runtime(root, args):
    """Finish pinned installation in an owned environment, including interrupted installs."""
    python = root / "venv/bin/python"
    env = clean_environment(os.environ)
    env["UV_CACHE_DIR"] = str(args.cache_dir or root / "cache")
    if not (root / "venv").exists():
        subprocess.run([args.uv, "venv", str(root / "venv"), "--python", args.python], env=env, check=True)
    private_path(root / "venv", directory=True)
    subprocess.run([args.uv, "pip", "install", "--python", str(python),
                    f"openviking[local-embed]=={SERVER_VERSION}", f"llama-cpp-python=={LLAMA_VERSION}"],
                   env=env, check=True)
    check = "import importlib.metadata as m; assert m.version('openviking') == %r; assert m.version('llama-cpp-python') == %r" % (SERVER_VERSION, LLAMA_VERSION)
    subprocess.run([str(python), "-c", check], env=env, check=True)


def prepare(args):
    """Prepare files only; never load launchd, connect a client, or replace user state."""
    if sys.platform != "darwin":
        raise ValueError("This deployment helper requires macOS launchd")
    root = args.root
    os.umask(0o077)
    created = False
    try:
        root.mkdir(mode=0o700, parents=True)
        created = True
    except FileExistsError:
        private_path(root, directory=True)
    if not created and not (root / "deployment.json").exists():
        raise ValueError(f"Refusing to adopt an unrecognized existing directory: {root}")
    private_path(args.credentials_file)
    with os.fdopen(os.open(root / ".prepare.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = {"managedBy": MANAGED, "serverVersion": SERVER_VERSION, "port": args.port,
                 "model": args.model, "credentialsFile": str(args.credentials_file)}
        write_preserved(root / "deployment.json", json_bytes(state))
        for folder in ("config", "data", "logs", "models"):
            path = root / folder
            path.mkdir(mode=0o700, exist_ok=True)
            private_path(path, directory=True)
        write_preserved(root / "config/ov.conf", json_bytes(server_config(root, args.port, args.model)))
        token_path = root / "config/secrets.json"
        if token_path.exists() or token_path.is_symlink():
            token = read_private_json(token_path).get("rootApiKey")
            if not isinstance(token, str) or len(token) < 32:
                raise ValueError("Existing root token is invalid; preserve it for recovery")
        else:
            write_preserved(token_path, json_bytes({"rootApiKey": secrets.token_urlsafe(48)}))
        model_path = root / "models" / f"{MODEL}.gguf"
        if not model_path.exists() and not model_path.is_symlink():
            if args.model_source:
                if model_hash(args.model_source) != MODEL_SHA256:
                    raise ValueError("The supplied model hash differs from the pinned model")
                with model_path.open("xb") as target, args.model_source.open("rb") as source:
                    shutil.copyfileobj(source, target)
            else:
                with model_path.open("xb") as target, urllib.request.urlopen(MODEL_URL, timeout=300) as source:
                    shutil.copyfileobj(source, target)
        private_path(model_path)
        if model_hash(model_path) != MODEL_SHA256:
            raise ValueError("The downloaded model is incomplete or has the wrong hash; preserve it before retrying")
        install_runtime(root, args)
        write_preserved(root / "openviking-local.py", Path(__file__).read_bytes())
        for name in ("server.stdout.log", "server.stderr.log"):
            path = root / "logs" / name
            if not path.exists():
                write_preserved(path, b"")
            private_path(path)
        write_preserved(root / f"{LABEL}.plist", plistlib.dumps(launchd_config(root)))
        deployment(root)
    print(json.dumps({"prepared": str(root), "serverVersion": SERVER_VERSION,
                      "launchdLoaded": False, "clientConnected": False}))


class ApiError(RuntimeError):
    """Expose only the status code and public route for a failed HTTP request."""

    def __init__(self, method, path, status):
        self.status = status
        super().__init__(f"OpenViking {method} {path} returned HTTP {status}")


def api(root, method, path, key=None, body=None):
    """Call the configured loopback API without including request secrets in errors."""
    state = deployment(root)
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    request = urllib.request.Request(f"http://127.0.0.1:{state['port']}{path}",
                                     method=method, headers=headers,
                                     data=None if body is None else json_bytes(body))
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        raise ApiError(method, path, error.code) from None
    if payload.get("status") != "ok":
        raise RuntimeError(f"OpenViking {method} {path} did not return success")
    return payload.get("result", payload)


@contextlib.contextmanager
def provision_lock(root):
    """Serialize provisioning so one private seed owns all retried API writes."""
    with os.fdopen(os.open(root / ".provision.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def provision(root):
    """Recover seeded tenant creation without rotating an existing user key."""
    deployment(root)
    with provision_lock(root):
        _provision(root)


def _provision(root):
    state = deployment(root)
    client_path = root / "config/ovcli.conf"
    if client_path.exists() or client_path.is_symlink():
        client = read_private_json(client_path)
        if client.get("url") != f"http://127.0.0.1:{state['port']}":
            raise ValueError("Existing client endpoint differs; preserve its configuration")
        api(root, "GET", "/api/v1/sessions", client.get("api_key"))
        print(json.dumps({"clientReady": True, "existingKeyPreserved": True}))
        return
    from openviking.server.api_keys.new import generate_api_key

    seeds_path = root / "config/provision-seeds.json"
    if not seeds_path.exists() and not seeds_path.is_symlink():
        write_preserved(seeds_path, json_bytes({"admin": secrets.token_urlsafe(48), "user": secrets.token_urlsafe(48)}))
    seeds = read_private_json(seeds_path)
    if any(not isinstance(seeds.get(name), str) or len(seeds[name]) < 32 for name in ("admin", "user")):
        raise ValueError("Existing provisioning seeds are invalid; preserve them for recovery")
    root_key = read_private_json(root / "config/secrets.json")["rootApiKey"]
    admin_key = generate_api_key("clawmaster", "owner", seeds["admin"])
    token = generate_api_key("clawmaster", "watchdog", seeds["user"])

    def authenticated(path, key):
        try:
            api(root, "GET", path, key)
            return True
        except ApiError as error:
            if error.status != 401:
                raise
            return False

    if not authenticated("/api/v1/sessions", token):
        if not authenticated("/api/v1/admin/accounts/clawmaster/users", admin_key):
            api(root, "POST", "/api/v1/admin/accounts", root_key,
                {"account_id": "clawmaster", "admin_user_id": "owner", "seed": seeds["admin"]})
        api(root, "POST", "/api/v1/admin/accounts/clawmaster/users", root_key,
            {"user_id": "watchdog", "role": "user", "seed": seeds["user"]})
        api(root, "GET", "/api/v1/sessions", token)
    write_preserved(client_path, json_bytes({"url": f"http://127.0.0.1:{state['port']}", "api_key": token}))
    print(json.dumps({"clientReady": True, "account": "clawmaster", "user": "watchdog", "role": "user"}))


def main():
    """Run preparation, foreground serving, diagnostics, or explicit tenant provisioning."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "serve", "doctor", "provision"))
    parser.add_argument("--root", type=Path, default=Path.home() / "Library/Application Support/ClawMaster/OpenViking")
    parser.add_argument("--credentials-file", type=Path, default=Path.home() / ".dsh/.credentials.yaml")
    parser.add_argument("--port", type=int, choices=range(1, 65536), default=1933, metavar="PORT")
    parser.add_argument("--model", default="deepseek-flash")
    parser.add_argument("--uv", default="uv")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--model-source", type=Path)
    args = parser.parse_args()
    args.root = args.root.expanduser().absolute()
    args.credentials_file = args.credentials_file.expanduser().absolute()
    os.umask(0o077)
    try:
        if args.command == "prepare":
            prepare(args)
        elif args.command == "provision":
            provision(args.root)
        else:
            env = runtime_environment(args.root)
            command = [str(args.root / "venv/bin/openviking-server")]
            if args.command == "serve":
                os.chdir(args.root)
                os.execve(command[0], command, env)
            command += ["doctor", "--config", str(args.root / "config/ov.conf")]
            result = subprocess.run(command, env=env, capture_output=True, text=True)
            output = result.stdout + result.stderr
            for key in ("DEEPSEEK_API_KEY", "OPENVIKING_ROOT_API_KEY"):
                output = output.replace(env[key], "[REDACTED]")
            print(output)
            return result.returncode
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"OpenViking local setup: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
