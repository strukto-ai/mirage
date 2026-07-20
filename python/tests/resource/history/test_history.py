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

import pytest

from mirage.observe.log_entry import EVENT_COMMAND, LogEntry
from mirage.observe.observer import Observer
from mirage.resource.history import HistoryViewResource
from mirage.types import FileType, MountMode
from mirage.utils.errors import OperationNotSupportedError
from mirage.workspace.mount.registry import MountRegistry


def _observer_with(commands: list[tuple[str, str]]) -> Observer:
    obs = Observer()
    for i, (cmd, session) in enumerate(commands):
        entry = LogEntry(
            type=EVENT_COMMAND,
            agent="a",
            session=session,
            timestamp=(i + 1) * 1000,
            command=cmd,
            exit_code=0,
        )
        asyncio.run(obs._log(entry))
    return obs


def _mounted(obs: Observer):
    registry = MountRegistry()
    registry.mount("/.bash_history", HistoryViewResource(obs), MountMode.READ)
    return registry.mount_for("/.bash_history")


def test_read_op_renders_gnu_file():
    mount = _mounted(_observer_with([("ls /data", "s1"), ("pwd", "s2")]))
    data = asyncio.run(mount.execute_op("read", "/.bash_history"))
    assert data == b"#1\nls /data\n#2\npwd\n"


def test_read_reflects_new_events_without_invalidation():
    obs = _observer_with([("ls /a", "s1")])
    mount = _mounted(obs)
    first = asyncio.run(mount.execute_op("read", "/.bash_history"))
    asyncio.run(
        obs._log(
            LogEntry(
                type=EVENT_COMMAND,
                agent="a",
                session="s1",
                timestamp=2000,
                command="pwd",
                exit_code=0,
            )))
    second = asyncio.run(mount.execute_op("read", "/.bash_history"))
    assert first != second
    assert second.endswith(b"#2\npwd\n")


def test_stat_op_reports_file():
    mount = _mounted(_observer_with([("ls /a", "s1")]))
    st = asyncio.run(mount.execute_op("stat", "/.bash_history"))
    assert st.type != FileType.DIRECTORY
    assert st.size == len(b"#1\nls /a\n")


def test_write_op_not_registered():
    mount = _mounted(_observer_with([]))
    with pytest.raises(OperationNotSupportedError):
        asyncio.run(mount.execute_op("write", "/.bash_history", b"x"))


def test_other_paths_not_found():
    mount = _mounted(_observer_with([("ls /a", "s1")]))
    with pytest.raises(FileNotFoundError):
        asyncio.run(mount.execute_op("read", "/.bash_history/nope"))
