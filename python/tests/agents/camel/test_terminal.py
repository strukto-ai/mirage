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

import pytest

from mirage import MountMode, Workspace
from mirage.agents.camel import MirageTerminalToolkit
from mirage.vfs.ram import RAMVFS


@pytest.fixture
def workspace():
    ram = RAMVFS()
    ws = Workspace({"/": ram}, mode=MountMode.WRITE)
    yield ws


@pytest.fixture
def toolkit(workspace):
    tk = MirageTerminalToolkit(workspace)
    yield tk
    tk.close()


def test_shell_exec_blocking_returns_stdout(toolkit):
    out = toolkit.shell_exec(id="t1", command="echo hello", block=True)
    assert "hello" in out


def test_shell_exec_blocking_captures_stderr(toolkit):
    out = toolkit.shell_exec(id="t1",
                             command="ls /nonexistent-zzz",
                             block=True)
    assert out, "expected non-empty output for failing command"


def test_shell_write_content_to_file(toolkit, workspace):
    msg = toolkit.shell_write_content_to_file(content="line1\nline2\n",
                                              file_path="/note.txt")
    assert "note.txt" in msg
    out = toolkit.shell_exec(id="t1", command="cat /note.txt", block=True)
    assert "line1" in out and "line2" in out


def test_shell_exec_nonblocking_returns_session_id(toolkit):
    msg = toolkit.shell_exec(id="bg1", command="sleep 0.5", block=False)
    assert "bg1" in msg


def test_shell_view_after_completion(toolkit):
    toolkit.shell_exec(id="bg2", command="echo done", block=False)
    out = toolkit.shell_view(id="bg2")
    assert "done" in out


def test_shell_kill_unknown_session(toolkit):
    msg = toolkit.shell_kill_process(id="never-started")
    assert "Error" in msg


def test_shell_write_to_process_returns_clear_error(toolkit):
    toolkit.shell_exec(id="bg3", command="sleep 0.5", block=False)
    msg = toolkit.shell_write_to_process(id="bg3", command="anything")
    assert "not interactive" in msg.lower()


def test_get_tools_returns_six(toolkit):
    tools = toolkit.get_tools()
    assert len(tools) == 6
