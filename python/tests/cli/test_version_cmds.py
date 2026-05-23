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
import subprocess
import sys
from pathlib import Path

CONFIG_YAML = """\
mounts:
  /:
    resource: ram
    mode: WRITE
"""


def _write_config(tmp_path: Path) -> Path:
    p = tmp_path / "config.yaml"
    p.write_text(CONFIG_YAML, encoding="utf-8")
    return p


def _run_cli(env: dict, *args: str, expect_exit: int = 0) -> dict | list:
    cmd = [sys.executable, "-m", "mirage.cli.main", *args]
    proc = subprocess.run(cmd, env=env, capture_output=True, timeout=30)
    if proc.returncode != expect_exit:
        raise AssertionError(
            f"exit={proc.returncode} (expected {expect_exit})\n"
            f"stdout: {proc.stdout.decode()}\nstderr: {proc.stderr.decode()}")
    if expect_exit != 0 or not proc.stdout.strip():
        return {}
    return json.loads(proc.stdout)


def test_log_empty_store_returns_empty(tmp_path):
    store = tmp_path / ".mirage"
    out = _run_cli(dict(os.environ), "workspace", "log", "--store", str(store))
    assert out == []


def test_version_flow_commit_log_status_diff_branch_checkout(daemon, tmp_path):
    env = daemon["env"]
    store = tmp_path / "proj" / ".mirage"
    cfg = _write_config(tmp_path)
    _run_cli(env, "workspace", "create", str(cfg), "--id", "vws")
    _run_cli(env, "execute", "-w", "vws", "-c", "echo one > /a.txt")

    committed = _run_cli(env, "workspace", "commit", "vws", "-m", "first",
                         "--store", str(store))
    assert len(committed["version"]) == 40
    assert committed["branch"] == "main"

    log = _run_cli(env, "workspace", "log", "--store", str(store))
    assert [v["message"] for v in log] == ["first"]
    v1 = log[0]["id"]

    _run_cli(env, "execute", "-w", "vws", "-c", "echo two > /a.txt")
    st = _run_cli(env, "workspace", "status", "vws", "--store", str(store))
    assert st["modified"] == ["a.txt"]

    c2 = _run_cli(env, "workspace", "commit", "vws", "-m", "second", "--store",
                  str(store))
    diff = _run_cli(env, "workspace", "diff", v1, c2["version"], "--store",
                    str(store))
    assert diff["modified"] == ["a.txt"]

    br = _run_cli(env, "workspace", "branch", "exp", "--store", str(store))
    assert br["branch"] == "exp"

    restored = _run_cli(env, "workspace", "checkout", v1, "--id",
                        "vws-restored", "--store", str(store))
    assert restored["id"] == "vws-restored"
    out = _run_cli(env, "execute", "-w", "vws-restored", "-c", "cat /a.txt")
    assert out["stdout"].startswith("one")

    _run_cli(env, "workspace", "delete", "vws")
    _run_cli(env, "workspace", "delete", "vws-restored")
