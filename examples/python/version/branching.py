# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

CONFIG_YAML = """\
mounts:
  /:
    resource: ram
    mode: WRITE
"""


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run(env: dict, *args: str) -> dict | list:
    cmd = [sys.executable, "-m", "mirage.cli.main", *args]
    proc = subprocess.run(cmd, env=env, capture_output=True, timeout=60)
    if proc.returncode != 0:
        raise RuntimeError(f"mirage {' '.join(args)} exited "
                           f"{proc.returncode}\n{proc.stderr.decode()}")
    out = proc.stdout.strip()
    return json.loads(out) if out else {}


def show_log(env: dict, wid: str, ref: str) -> None:
    entries = run(env, "workspace", "log", wid, "-b", ref)
    print(f"=== log {ref} ===")
    for e in entries:
        print(e["message"])


def show_diff(env: dict, wid: str, a: str, b: str) -> None:
    changes = run(env, "workspace", "diff", wid, a, b)
    print(f"=== diff {a} {b} ===")
    for path in changes["added"]:
        print(f"added: {path}")
    for path in changes["modified"]:
        print(f"modified: {path}")
    for path in changes["deleted"]:
        print(f"deleted: {path}")


def main() -> None:
    work = Path(tempfile.mkdtemp(prefix="mirage-version-"))
    env = dict(os.environ)
    env["MIRAGE_DAEMON_URL"] = f"http://127.0.0.1:{free_port()}"
    env["MIRAGE_VERSION_ROOT"] = str(work / "repos")
    env["MIRAGE_IDLE_GRACE_SECONDS"] = "60"
    cfg = work / "config.yaml"
    cfg.write_text(CONFIG_YAML, encoding="utf-8")
    try:
        wid = run(env, "workspace", "create", str(cfg))["id"]
        print("=== create workspace (ram mount) ===")

        run(env, "execute", "-w", wid, "-c", "echo one > /a.txt")
        run(env, "workspace", "commit", wid, "-m", "first")
        print("=== committed 'first' on main ===")

        run(env, "workspace", "branch", wid, "exp")
        print("=== branched exp from main ===")

        run(env, "execute", "-w", wid, "-c", "echo two > /a.txt")
        run(env, "execute", "-w", wid, "-c", "echo new > /b.txt")
        run(env, "workspace", "commit", wid, "-b", "exp", "-m", "on exp")
        print("=== committed 'on exp' on exp ===")

        run(env, "execute", "-w", wid, "-c", "echo three > /a.txt")
        run(env, "execute", "-w", wid, "-c", "rm /b.txt")
        run(env, "workspace", "commit", wid, "-b", "main", "-m", "second")
        print("=== committed 'second' on main ===")

        show_log(env, wid, "main")
        show_log(env, wid, "exp")
        show_diff(env, wid, "main", "exp")
    finally:
        subprocess.run(
            [sys.executable, "-m", "mirage.cli.main", "daemon", "stop"],
            env=env,
            capture_output=True,
            timeout=30)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
