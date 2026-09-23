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

from mirage.commands.config import ExecContext
from mirage.observe.log_entry import EVENT_COMMAND, LogEntry
from mirage.observe.observer import Observer
from mirage.types import MountMode
from mirage.vfs.history import HistoryViewVFS
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
    registry.mount("/.bash_history", HistoryViewVFS(obs), MountMode.READ)
    return registry.mount_for("/.bash_history")


async def _drain(stream) -> bytes:
    if stream is None:
        return b""
    if isinstance(stream, (bytes, bytearray)):
        return bytes(stream)
    chunks = [chunk async for chunk in stream]
    return b"".join(chunks)


async def _history(mount, texts=(), session_id="s1", **flags):
    stream, io = await mount.execute_cmd("history", [], list(texts), flags,
                                         ExecContext(session_id=session_id))
    return await _drain(stream), io


def test_history_numbers_session_events():
    mount = _mounted(
        _observer_with([("ls /a", "s1"), ("pwd", "s1"), ("other", "s2")]))
    out, io = asyncio.run(_history(mount))
    assert io.exit_code == 0
    assert out == b"1  ls /a\n2  pwd\n"


def test_history_filters_to_caller_session():
    mount = _mounted(_observer_with([("ls /a", "s1"), ("other", "s2")]))
    out, _ = asyncio.run(_history(mount, session_id="s2"))
    assert out == b"1  other\n"


def test_history_last_n():
    mount = _mounted(_observer_with([("c1", "s1"), ("c2", "s1"),
                                     ("c3", "s1")]))
    out, _ = asyncio.run(_history(mount, texts=("2", )))
    assert out == b"2  c2\n3  c3\n"


def test_history_non_numeric_arg_errors():
    mount = _mounted(_observer_with([("c1", "s1")]))
    out, io = asyncio.run(_history(mount, texts=("abc", )))
    assert io.exit_code == 1
    assert b"numeric argument required" in io.stderr


def test_history_c_clears_only_caller_session():
    obs = _observer_with([("c1", "s1"), ("c2", "s2")])
    mount = _mounted(obs)
    _, io = asyncio.run(_history(mount, session_id="s1", c=True))
    assert io.exit_code == 0
    out_s1, _ = asyncio.run(_history(mount, session_id="s1"))
    out_s2, _ = asyncio.run(_history(mount, session_id="s2"))
    assert out_s1 == b""
    assert out_s2 == b"1  c2\n"


def test_history_c_leaves_bash_history_file_unchanged():
    obs = _observer_with([("c1", "s1")])
    mount = _mounted(obs)
    asyncio.run(_history(mount, session_id="s1", c=True))
    data = asyncio.run(mount.execute_op("read", "/.bash_history"))
    assert data == b"#1\nc1\n"


def test_history_empty_session():
    mount = _mounted(_observer_with([("c1", "s1")]))
    out, io = asyncio.run(_history(mount, session_id="fresh"))
    assert io.exit_code == 0
    assert out == b""
