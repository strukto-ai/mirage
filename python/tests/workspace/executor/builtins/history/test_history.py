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

from mirage import RAMVFS, MountMode, Workspace
from mirage.observe.observer import Observer
from mirage.workspace.executor.builtins.history.history import (
    _parse_args,
    handle_history,
)
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.session import SessionState


def recording() -> MountRegistry:
    registry = MountRegistry()
    registry.observer = Observer()
    return registry


def session() -> SessionState:
    return SessionState(session_id="test")


@pytest.fixture
def ws():
    return Workspace({"/ram": RAMVFS()}, mode=MountMode.WRITE)


def test_parse_args_collects_clustered_option_letters():
    flags, texts, error = _parse_args(["-c", "-w"])
    assert error is None
    assert flags == {"c": True, "w": True}
    assert texts == []


def test_parse_args_rejects_an_unknown_option_letter():
    flags, texts, error = _parse_args(["-x"])
    assert error == "bash: history: -x: invalid option\n"
    assert (flags, texts) == ({}, [])


def test_parse_args_treats_a_digit_as_an_invalid_option_like_bash():
    _, _, error = _parse_args(["-1"])
    assert error == "bash: history: -1: invalid option\n"


def test_parse_args_takes_the_d_offset_attached_to_its_token():
    flags, _, error = _parse_args(["-d3"])
    assert error is None
    assert flags["d"] == "3"


def test_parse_args_reads_an_attached_letter_as_the_d_offset_not_an_option():
    flags, _, error = _parse_args(["-dc"])
    assert error is None
    assert flags == {"d": "c"}


def test_parse_args_takes_the_next_token_as_the_d_offset_when_detached():
    flags, _, error = _parse_args(["-d", "7"])
    assert error is None
    assert flags["d"] == "7"


def test_parse_args_requires_an_argument_for_a_trailing_d():
    _, _, error = _parse_args(["-d"])
    assert error == "bash: history: -d: option requires an argument\n"


def test_parse_args_stops_option_parsing_at_the_first_operand():
    flags, texts, error = _parse_args(["-s", "rm", "-rf"])
    assert error is None
    assert flags == {"s": True}
    assert texts == ["rm", "-rf"]


def test_parse_args_stops_option_parsing_at_a_double_dash():
    flags, texts, error = _parse_args(["--", "-c"])
    assert error is None
    assert flags == {}
    assert texts == ["-c"]


def test_parse_args_reads_a_bare_dash_as_an_operand():
    _, texts, error = _parse_args(["-"])
    assert error is None
    assert texts == ["-"]


@pytest.mark.asyncio
async def test_history_reports_a_usage_error_with_status_2():
    _, io, node = await handle_history(recording(), ["-x"], session())
    assert io.exit_code == 2
    assert node.exit_code == 2
    assert io.stderr.startswith(b"bash: history: -x: invalid option\n")
    assert b"history: usage: history [-c]" in io.stderr


@pytest.mark.asyncio
async def test_history_reports_when_the_workspace_has_no_recorder():
    _, io, _ = await handle_history(MountRegistry(), [], session())
    assert io.exit_code == 1
    assert io.stderr == b"bash: history: not enabled for this workspace\n"


@pytest.mark.asyncio
async def test_history_s_stores_its_words_as_one_entry_the_listing_shows():
    registry = recording()
    stream, io, node = await handle_history(
        registry, ["-s", "echo", "hi"], session()
    )
    assert stream is None
    assert io.exit_code == 0
    assert node.command == "history"
    listed, _, _ = await handle_history(registry, [], session())
    assert listed == b"1  echo hi\n"


@pytest.mark.asyncio
async def test_history_p_prints_its_words_without_storing_them():
    registry = recording()
    stream, _, _ = await handle_history(registry, ["-p", "a", "b"], session())
    assert stream == b"a\nb\n"
    listed, _, _ = await handle_history(registry, [], session())
    assert listed == b""


@pytest.mark.asyncio
async def test_history_puts_an_out_of_range_offset_on_the_node():
    _, io, node = await handle_history(recording(), ["-d", "5"], session())
    err = b"bash: history: 5: history position out of range\n"
    assert io.exit_code == 1
    assert io.stderr == err
    assert node.exit_code == 1
    assert node.stderr == err


@pytest.mark.asyncio
async def test_history_lists_recent_commands(ws):
    await ws.shell("echo hello")
    await ws.shell("echo world")
    io = await ws.shell("history")
    out = (io.stdout or b"").decode()
    assert "echo hello" in out
    assert "echo world" in out
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_history_n_returns_last_n(ws):
    await ws.shell("echo a")
    await ws.shell("echo b")
    await ws.shell("echo c")
    io = await ws.shell("history 2")
    out = (io.stdout or b"").decode()
    lines = [line for line in out.strip().split("\n") if line.strip()]
    assert len(lines) == 2
    assert "echo c" in lines[-1]


@pytest.mark.asyncio
async def test_history_dash_c_clears(ws):
    await ws.shell("echo a")
    await ws.shell("echo b")
    clear_io = await ws.shell("history -c")
    assert clear_io.exit_code == 0
    io = await ws.shell("history")
    out = (io.stdout or b"").decode()
    lines = [line for line in out.strip().split("\n") if line.strip()]
    assert len(lines) == 1
    assert "history" in lines[-1]


@pytest.mark.asyncio
async def test_history_invalid_numeric_arg(ws):
    await ws.shell("echo a")
    io = await ws.shell("history abc")
    assert io.exit_code == 1
    err = (io.stderr or b"").decode()
    assert "numeric" in err


@pytest.mark.asyncio
async def test_history_isolated_per_session(ws):
    ws.create_session("alice")
    ws.create_session("bob")
    await ws.shell("echo from-alice", session_id="alice")
    await ws.shell("echo from-bob", session_id="bob")
    io_a = await ws.shell("history", session_id="alice")
    out_a = (io_a.stdout or b"").decode()
    assert "from-alice" in out_a
    assert "from-bob" not in out_a
    io_b = await ws.shell("history", session_id="bob")
    out_b = (io_b.stdout or b"").decode()
    assert "from-bob" in out_b
    assert "from-alice" not in out_b
