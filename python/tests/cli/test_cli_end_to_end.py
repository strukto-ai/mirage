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


def _run_cli(env: dict,
             *args: str,
             stdin: bytes | None = None,
             expect_exit: int = 0) -> dict | list:
    cmd = [sys.executable, "-m", "mirage.cli.main", *args]
    proc = subprocess.run(
        cmd,
        env=env,
        input=stdin,
        capture_output=True,
        timeout=30,
    )
    if proc.returncode != expect_exit:
        raise AssertionError(
            f"exit={proc.returncode} (expected {expect_exit})\n"
            f"stdout: {proc.stdout.decode()}\nstderr: {proc.stderr.decode()}")
    if expect_exit != 0:
        return {}
    if not proc.stdout.strip():
        return {}
    return json.loads(proc.stdout)


def test_workspace_lifecycle(daemon, tmp_path):
    cfg = _write_config(tmp_path)
    created = _run_cli(daemon["env"], "workspace", "create", str(cfg))
    wid = created["id"]
    assert wid.startswith("ws_")

    listed = _run_cli(daemon["env"], "workspace", "list")
    assert any(w["id"] == wid for w in listed)

    detail = _run_cli(daemon["env"], "workspace", "get", wid)
    assert detail["id"] == wid

    deleted = _run_cli(daemon["env"], "workspace", "delete", wid)
    assert deleted["id"] == wid


def test_workspace_create_with_explicit_id(daemon, tmp_path):
    cfg = _write_config(tmp_path)
    created = _run_cli(daemon["env"], "workspace", "create", str(cfg), "--id",
                       "custom-ws")
    assert created["id"] == "custom-ws"
    _run_cli(daemon["env"], "workspace", "delete", "custom-ws")


def test_session_lifecycle(daemon, tmp_path):
    cfg = _write_config(tmp_path)
    created = _run_cli(daemon["env"], "workspace", "create", str(cfg), "--id",
                       "sess-test-ws")
    wid = created["id"]
    sess = _run_cli(daemon["env"], "session", "create", wid, "--id", "agent_a")
    assert sess["session_id"] == "agent_a"

    listed = _run_cli(daemon["env"], "session", "list", wid)
    assert any(s["session_id"] == "agent_a" for s in listed)

    _run_cli(daemon["env"], "session", "delete", wid, "agent_a")
    _run_cli(daemon["env"], "workspace", "delete", wid)


def test_execute_returns_json_io_result(daemon, tmp_path):
    cfg = _write_config(tmp_path)
    created = _run_cli(daemon["env"], "workspace", "create", str(cfg), "--id",
                       "exec-test")
    result = _run_cli(daemon["env"], "execute", "--workspace_id",
                      created["id"], "--command", "echo hello")
    assert result["kind"] == "io"
    assert result["exit_code"] == 0
    assert result["stdout"].startswith("hello")
    _run_cli(daemon["env"], "workspace", "delete", "exec-test")


def test_execute_background_returns_job_id(daemon, tmp_path):
    cfg = _write_config(tmp_path)
    _run_cli(daemon["env"], "workspace", "create", str(cfg), "--id", "bg-test")
    submitted = _run_cli(daemon["env"], "execute", "--workspace_id", "bg-test",
                         "--command", "echo bg", "--background")
    job_id = submitted["job_id"]
    assert job_id.startswith("job_")

    waited = _run_cli(daemon["env"], "job", "wait", job_id)
    assert waited["status"] == "done"
    assert waited["result"]["stdout"].startswith("bg")
    _run_cli(daemon["env"], "workspace", "delete", "bg-test")


def test_execute_with_stdin_pipe(daemon, tmp_path):
    cfg = _write_config(tmp_path)
    _run_cli(daemon["env"], "workspace", "create", str(cfg), "--id",
             "stdin-test")
    result = _run_cli(daemon["env"],
                      "execute",
                      "--workspace_id",
                      "stdin-test",
                      "--command",
                      "wc -l",
                      stdin=b"a\nb\nc\n")
    assert result["exit_code"] == 0
    assert result["stdout"].strip().startswith("3")
    _run_cli(daemon["env"], "workspace", "delete", "stdin-test")


def test_save_then_load_round_trip(daemon, tmp_path):
    cfg = _write_config(tmp_path)
    _run_cli(daemon["env"], "workspace", "create", str(cfg), "--id",
             "save-test")
    _run_cli(daemon["env"], "execute", "--workspace_id", "save-test",
             "--command", "echo persisted > /report.txt")

    tar_path = tmp_path / "snap.tar"
    saved = _run_cli(daemon["env"], "workspace", "snapshot", "save-test",
                     str(tar_path))
    assert saved["bytes"] > 0
    assert tar_path.exists()

    loaded = _run_cli(daemon["env"], "workspace", "load", str(tar_path),
                      "--id", "loaded-ws")
    assert loaded["id"] == "loaded-ws"

    result = _run_cli(daemon["env"], "execute", "--workspace_id", "loaded-ws",
                      "--command", "cat /report.txt")
    assert "persisted" in result["stdout"]
    _run_cli(daemon["env"], "workspace", "delete", "save-test")
    _run_cli(daemon["env"], "workspace", "delete", "loaded-ws")


def test_workspace_get_verbose_includes_internals(daemon, tmp_path):
    cfg = _write_config(tmp_path)
    _run_cli(daemon["env"], "workspace", "create", str(cfg), "--id",
             "verbose-test")
    plain = _run_cli(daemon["env"], "workspace", "get", "verbose-test")
    assert plain["internals"] is None

    verbose = _run_cli(daemon["env"], "workspace", "get", "verbose-test",
                       "--verbose")
    assert verbose["internals"] is not None
    assert "cache_bytes" in verbose["internals"]
    _run_cli(daemon["env"], "workspace", "delete", "verbose-test")


def test_unknown_workspace_returns_nonzero(daemon, tmp_path):
    _run_cli(daemon["env"],
             "workspace",
             "get",
             "ws_doesnotexist",
             expect_exit=2)


def test_env_interpolation_uses_cli_environment(daemon, tmp_path):
    """${VAR}s in the YAML must be resolved from the CLI's env, not the
    daemon's. The cross-mount workflow assumes the user sources their
    creds before running `mirage workspace create` -- the daemon
    process won't have those vars."""
    cfg = tmp_path / "interp.yaml"
    cfg.write_text(
        "mounts:\n"
        "  /:\n"
        "    resource: ram\n"
        "    mode: ${MOUNT_MODE_FROM_ENV}\n",
        encoding="utf-8",
    )
    env = {**daemon["env"], "MOUNT_MODE_FROM_ENV": "WRITE"}
    _run_cli(env, "workspace", "create", str(cfg), "--id", "interp-test")
    detail = _run_cli(env, "workspace", "get", "interp-test")
    assert any(m["mode"] == "write" for m in detail["mounts"])
    _run_cli(env, "workspace", "delete", "interp-test")


def test_daemon_status_running(daemon, tmp_path):
    out = _run_cli(daemon["env"], "daemon", "status")
    assert out["running"] is True
    assert out["pid"] is not None
    assert out["workspaces"] == 0


def test_daemon_stop_then_status_not_running(daemon, tmp_path):
    out = _run_cli(daemon["env"], "daemon", "stop")
    assert out["stopped"] is True
    import time
    time.sleep(0.5)
    out = _run_cli(daemon["env"], "daemon", "status", expect_exit=1)
    assert out == {} or out.get("running") is False


def test_provision_returns_dry_run_result(daemon, tmp_path):
    """`mirage provision` hits /execute with provision=True and returns
    a {"kind": "provision", ...} payload instead of actually running."""
    cfg = _write_config(tmp_path)
    _run_cli(daemon["env"], "workspace", "create", str(cfg), "--id",
             "provision-test")
    result = _run_cli(
        daemon["env"],
        "provision",
        "--workspace_id",
        "provision-test",
        "--command",
        "echo would-not-run",
    )
    assert result["kind"] == "provision"
    _run_cli(daemon["env"], "workspace", "delete", "provision-test")


def test_execute_propagates_inner_exit_code(daemon, tmp_path):
    cfg = _write_config(tmp_path)
    _run_cli(daemon["env"], "workspace", "create", str(cfg), "--id",
             "exit-test")

    ok = _run_cli(daemon["env"], "execute", "-w", "exit-test", "-c", "echo ok")
    assert ok["exit_code"] == 0

    _run_cli(daemon["env"],
             "execute",
             "-w",
             "exit-test",
             "-c",
             "false",
             expect_exit=1)

    bg = _run_cli(daemon["env"], "execute", "-w", "exit-test", "-c", "false",
                  "--background")
    job_id = bg["job_id"]
    _run_cli(daemon["env"], "job", "wait", job_id, expect_exit=1)

    _run_cli(daemon["env"], "workspace", "delete", "exit-test")


def test_execute_subshell_cwd_does_not_leak(daemon, tmp_path):
    cfg = _write_config(tmp_path)
    _run_cli(daemon["env"], "workspace", "create", str(cfg), "--id",
             "subshell")
    _run_cli(daemon["env"], "execute", "-w", "subshell", "-c", "mkdir /sub")
    inside = _run_cli(daemon["env"], "execute", "-w", "subshell", "-c",
                      "(cd /sub && pwd)")
    assert inside["stdout"].strip() == "/sub"
    after = _run_cli(daemon["env"], "execute", "-w", "subshell", "-c", "pwd")
    assert after["stdout"].strip() == "/"
    _run_cli(daemon["env"], "workspace", "delete", "subshell")


def test_execute_env_prefix_does_not_leak(daemon, tmp_path):
    cfg = _write_config(tmp_path)
    _run_cli(daemon["env"], "workspace", "create", str(cfg), "--id", "envpref")
    inside = _run_cli(daemon["env"], "execute", "-w", "envpref", "-c",
                      "(export FOO=bar; printenv FOO)")
    assert inside["stdout"].strip() == "bar"
    after = _run_cli(daemon["env"], "execute", "-w", "envpref", "-c",
                     "printenv FOO || echo absent")
    assert after["stdout"].strip() == "absent"
    _run_cli(daemon["env"], "workspace", "delete", "envpref")


def test_execute_background_then_cancel(daemon, tmp_path):
    cfg = _write_config(tmp_path)
    _run_cli(daemon["env"], "workspace", "create", str(cfg), "--id",
             "cancel-test")
    submitted = _run_cli(daemon["env"], "execute", "-w", "cancel-test", "-c",
                         "sleep 30", "--background")
    job_id = submitted["job_id"]
    _run_cli(daemon["env"], "job", "cancel", job_id)
    waited = _run_cli(daemon["env"], "job", "wait", job_id, expect_exit=2)
    assert waited == {}
    _run_cli(daemon["env"], "workspace", "delete", "cancel-test")


def test_missing_env_var_fails_fast_before_daemon_call(daemon, tmp_path):
    cfg = tmp_path / "missing.yaml"
    cfg.write_text(
        "mounts:\n"
        "  /:\n"
        "    resource: ram\n"
        "    mode: ${THIS_VAR_IS_NOT_SET_ANYWHERE}\n",
        encoding="utf-8",
    )
    env = {
        k: v
        for k, v in daemon["env"].items()
        if k != "THIS_VAR_IS_NOT_SET_ANYWHERE"
    }
    _run_cli(env, "workspace", "create", str(cfg), expect_exit=2)
