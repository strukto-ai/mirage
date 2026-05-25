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


def _run(env: dict, *args: str, expect_exit: int = 0) -> dict | list:
    cmd = [sys.executable, "-m", "mirage.cli.main", *args]
    proc = subprocess.run(cmd, env=env, capture_output=True, timeout=30)
    if proc.returncode != expect_exit:
        raise AssertionError(
            f"exit={proc.returncode} (expected {expect_exit})\n"
            f"stdout: {proc.stdout.decode()}\nstderr: {proc.stderr.decode()}")
    if expect_exit != 0 or not proc.stdout.strip():
        return {}
    return json.loads(proc.stdout)


def test_commit_log_checkout_clone(daemon, tmp_path):
    env = daemon["env"]
    cfg = _write_config(tmp_path)
    wid = _run(env, "workspace", "create", str(cfg))["id"]

    _run(env, "execute", "-w", wid, "-c", "echo v1 > /notes.txt")
    v1 = _run(env, "workspace", "commit", wid, "-m", "first")["version"]

    _run(env, "execute", "-w", wid, "-c", "echo v2 > /notes.txt")
    _run(env, "workspace", "commit", wid, "-m", "second")

    log = _run(env, "workspace", "log", wid)
    assert [e["message"] for e in log] == ["second", "first"]

    _run(env, "workspace", "checkout", wid, v1)
    reverted = _run(env, "execute", "-w", wid, "-c", "cat /notes.txt")
    assert reverted["stdout"] == "v1\n"

    clone = _run(env, "workspace", "clone", wid, "--at", v1)
    assert clone["id"] != wid


def test_log_empty_before_commit(daemon, tmp_path):
    env = daemon["env"]
    cfg = _write_config(tmp_path)
    wid = _run(env, "workspace", "create", str(cfg))["id"]
    assert _run(env, "workspace", "log", wid) == []


def test_diff_versions_and_live(daemon, tmp_path):
    env = daemon["env"]
    cfg = _write_config(tmp_path)
    wid = _run(env, "workspace", "create", str(cfg))["id"]

    _run(env, "execute", "-w", wid, "-c", "echo one > /a.txt")
    v1 = _run(env, "workspace", "commit", wid, "-m", "first")["version"]

    _run(env, "execute", "-w", wid, "-c", "echo two > /a.txt")
    _run(env, "execute", "-w", wid, "-c", "echo new > /b.txt")
    v2 = _run(env, "workspace", "commit", wid, "-m", "second")["version"]

    by_version = _run(env, "workspace", "diff", wid, v1, v2)
    assert by_version["modified"] == ["a.txt"]
    assert by_version["added"] == ["b.txt"]

    _run(env, "execute", "-w", wid, "-c", "echo three > /a.txt")
    live = _run(env, "workspace", "diff", wid)
    assert live["modified"] == ["a.txt"]


def test_branch_diverges_and_guards_commit(daemon, tmp_path):
    env = daemon["env"]
    cfg = _write_config(tmp_path)
    wid = _run(env, "workspace", "create", str(cfg))["id"]

    _run(env, "execute", "-w", wid, "-c", "echo one > /a.txt")
    _run(env, "workspace", "commit", wid, "-m", "first")

    _run(env, "workspace", "branch", wid, "exp")
    _run(env, "execute", "-w", wid, "-c", "echo two > /a.txt")
    _run(env, "workspace", "commit", wid, "-b", "exp", "-m", "on exp")

    exp_log = _run(env, "workspace", "log", wid, "-b", "exp")
    main_log = _run(env, "workspace", "log", wid, "-b", "main")
    assert [e["message"] for e in exp_log] == ["on exp", "first"]
    assert [e["message"] for e in main_log] == ["first"]

    _run(env,
         "workspace",
         "commit",
         wid,
         "-b",
         "ghost",
         "-m",
         "x",
         expect_exit=2)


def test_diff_includes_deleted(daemon, tmp_path):
    env = daemon["env"]
    cfg = _write_config(tmp_path)
    wid = _run(env, "workspace", "create", str(cfg))["id"]

    _run(env, "execute", "-w", wid, "-c", "echo one > /a.txt")
    _run(env, "execute", "-w", wid, "-c", "echo two > /b.txt")
    v1 = _run(env, "workspace", "commit", wid, "-m", "first")["version"]

    _run(env, "execute", "-w", wid, "-c", "rm /b.txt")
    v2 = _run(env, "workspace", "commit", wid, "-m", "second")["version"]

    changes = _run(env, "workspace", "diff", wid, v1, v2)
    assert changes["deleted"] == ["b.txt"]


def test_clone_live_and_explicit_id(daemon, tmp_path):
    env = daemon["env"]
    cfg = _write_config(tmp_path)
    wid = _run(env, "workspace", "create", str(cfg))["id"]
    _run(env, "execute", "-w", wid, "-c", "echo hello > /a.txt")

    auto = _run(env, "workspace", "clone", wid)
    assert auto["id"] != wid

    named = _run(env, "workspace", "clone", wid, "--id", "myclone")
    assert named["id"] == "myclone"
    got = _run(env, "execute", "-w", "myclone", "-c", "cat /a.txt")
    assert got["stdout"] == "hello\n"


def test_branch_from_non_main(daemon, tmp_path):
    env = daemon["env"]
    cfg = _write_config(tmp_path)
    wid = _run(env, "workspace", "create", str(cfg))["id"]

    _run(env, "execute", "-w", wid, "-c", "echo one > /a.txt")
    _run(env, "workspace", "commit", wid, "-m", "first")
    _run(env, "workspace", "branch", wid, "exp")
    _run(env, "execute", "-w", wid, "-c", "echo two > /a.txt")
    _run(env, "workspace", "commit", wid, "-b", "exp", "-m", "on exp")

    _run(env, "workspace", "branch", wid, "exp2", "--from", "exp")
    log = _run(env, "workspace", "log", wid, "-b", "exp2")
    assert [e["message"] for e in log] == ["on exp", "first"]


def test_checkout_by_branch_name(daemon, tmp_path):
    env = daemon["env"]
    cfg = _write_config(tmp_path)
    wid = _run(env, "workspace", "create", str(cfg))["id"]

    _run(env, "execute", "-w", wid, "-c", "echo one > /a.txt")
    _run(env, "workspace", "commit", wid, "-m", "first")
    _run(env, "workspace", "branch", wid, "exp")
    _run(env, "execute", "-w", wid, "-c", "echo two > /a.txt")
    _run(env, "workspace", "commit", wid, "-b", "exp", "-m", "on exp")

    _run(env, "workspace", "checkout", wid, "main")
    on_main = _run(env, "execute", "-w", wid, "-c", "cat /a.txt")
    assert on_main["stdout"] == "one\n"

    _run(env, "workspace", "checkout", wid, "exp")
    on_exp = _run(env, "execute", "-w", wid, "-c", "cat /a.txt")
    assert on_exp["stdout"] == "two\n"


def test_error_paths_exit_2(daemon, tmp_path):
    env = daemon["env"]
    cfg = _write_config(tmp_path)
    wid = _run(env, "workspace", "create", str(cfg))["id"]
    _run(env, "execute", "-w", wid, "-c", "echo one > /a.txt")
    _run(env, "workspace", "commit", wid, "-m", "first")
    _run(env, "workspace", "branch", wid, "exp")

    _run(env, "workspace", "branch", wid, "exp", expect_exit=2)
    _run(env, "workspace", "commit", "ghost-ws", "-m", "x", expect_exit=2)
    _run(env, "workspace", "checkout", wid, "nope", expect_exit=2)
    _run(env, "workspace", "diff", wid, "nope", "nope2", expect_exit=2)
