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

import asyncio
import time

import pytest

pytest.importorskip("tools.environments.base")

from tools.file_operations import ShellFileOperations
from tools.process_registry import ProcessRegistry

from mirage import RAMVFS, MountMode, Workspace
from mirage.agents.hermes import MirageEnvironment


def build_workspace(processes: str) -> Workspace:
    return Workspace(
        {"/tmp": RAMVFS(), "/data": RAMVFS()},
        mode=MountMode.WRITE,
        processes=processes,
    )


@pytest.fixture
def ws():
    workspace = build_workspace("workspace")
    yield workspace
    asyncio.run(workspace.close())


@pytest.fixture
def env(ws):
    environment = MirageEnvironment(
        ws, cwd="/", timeout=30, task_id="t", secrets={}
    )
    yield environment
    environment.cleanup()


def test_exports_and_cwd_carry_between_commands(env):
    assert env.execute("export A=1; cd /data")["returncode"] == 0
    result = env.execute("echo $A; pwd")
    assert result["returncode"] == 0
    assert result["output"].split() == ["1", "/data"]


def test_exit_code_is_returncode(env):
    assert env.execute("echo out; (exit 7)")["returncode"] == 7


def test_stderr_keeps_its_place_in_the_output(env):
    result = env.execute("echo a; echo b >&2; echo c")
    assert result["output"].split() == ["a", "b", "c"]


def test_stdin_reaches_the_command(env):
    result = env.execute("cat", stdin_data="hello\n")
    assert result["output"].strip() == "hello"


def test_timeout_cancels_the_mirage_line(env):
    result = env.execute("sleep 3; echo late > /data/late", timeout=1)
    assert result["returncode"] == 124
    assert result.get("hermes_timed_out") is True
    time.sleep(4)
    assert env.execute("test -e /data/late")["returncode"] == 1


def test_a_timed_out_command_keeps_what_it_printed(env):
    result = env.execute("echo diagnostic; sleep 5", timeout=1)
    assert result["returncode"] == 124
    assert "diagnostic" in result["output"], result


def test_background_job_is_polled_to_its_exit(env):
    registry = ProcessRegistry()
    session = registry.spawn_via_env(env, "sleep 1; echo done", cwd="/data")
    deadline = time.monotonic() + 20
    status = registry.poll(session.id)
    while status.get("status") != "exited" and time.monotonic() < deadline:
        time.sleep(0.5)
        status = registry.poll(session.id)
    assert status.get("status") == "exited", status
    assert status.get("exit_code") == 0, status
    assert "done" in status.get("output_preview", ""), status


def test_background_job_is_polled_while_a_foreground_command_runs(env):
    registry = ProcessRegistry()
    session = registry.spawn_via_env(env, "sleep 1; echo done", cwd="/data")
    assert env.execute("sleep 15; echo fg", timeout=30)["returncode"] == 0
    deadline = time.monotonic() + 20
    status = registry.poll(session.id)
    while status.get("status") != "exited" and time.monotonic() < deadline:
        time.sleep(0.5)
        status = registry.poll(session.id)
    assert status.get("exit_code") == 0, status
    assert "done" in status.get("output_preview", ""), status


def test_a_workspace_without_cross_session_processes_is_refused():
    workspace = build_workspace("session")
    try:
        with pytest.raises(ValueError, match="processes: workspace"):
            MirageEnvironment(
                workspace, cwd="/", timeout=30, task_id="t", secrets={}
            )
        assert not [
            s.session_id
            for s in workspace.list_sessions()
            if s.session_id.startswith("hermes-")
        ]
    finally:
        asyncio.run(workspace.close())


def test_file_tools_round_trip(env):
    ops = ShellFileOperations(env, cwd="/data")
    written = ops.write_file("/data/notes.txt", "one\ntwo\n")
    assert written.error is None, written.error
    assert "two" in ops.read_file("/data/notes.txt").content
    patched = ops.patch_replace("/data/notes.txt", "two", "three")
    assert patched.success, patched.error
    found = ops.search("three", path="/data")
    assert [m.path for m in found.matches] == ["/data/notes.txt"], found


def test_cleanup_closes_the_session(ws, env):
    env.cleanup()
    env.cleanup()
    assert env.execute("echo late")["returncode"] != 0
    assert not [
        s.session_id
        for s in ws.list_sessions()
        if s.session_id.startswith("hermes-t-")
    ]


def test_two_environments_of_one_task_keep_their_own_sessions(ws, env):
    other = MirageEnvironment(ws, cwd="/", timeout=30, task_id="t", secrets={})
    other.cleanup()
    assert env.execute("echo still")["output"].strip() == "still"


def test_cleanup_after_the_workspace_closed_does_not_raise():
    workspace = build_workspace("workspace")
    environment = MirageEnvironment(
        workspace, cwd="/", timeout=30, task_id="t", secrets={}
    )
    asyncio.run(workspace.close())
    environment.cleanup()
