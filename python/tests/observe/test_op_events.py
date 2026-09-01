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

from mirage import MountMode, Workspace
from mirage.observe.log_entry import EVENT_COMMAND, EVENT_OP
from mirage.resource.ram import RAMResource


async def _ws_after(*lines: str) -> Workspace:
    ws = Workspace({"/ram": RAMResource()}, mode=MountMode.WRITE)
    for line in lines:
        await ws.execute(line)
    return ws


async def _events_after(*lines: str) -> tuple[list[dict], list[dict]]:
    ws = await _ws_after(*lines)
    return await ws.observer.command_events(), await ws.observer.op_events()


async def _op_history_and_op_events() -> tuple[list[dict], list[dict]]:
    ws = await _ws_after("echo hi > /ram/x.txt")
    return await ws.op_history(), await ws.observer.op_events()


async def _history_types() -> set[str]:
    ws = await _ws_after("echo hi > /ram/x.txt")
    return {e["type"] for e in await ws.history()}


async def _line_events_of_second_command() -> list[dict]:
    ws = await _ws_after("echo hi > /ram/x.txt", "cat /ram/x.txt")
    commands = await ws.observer.command_events()
    return await ws.observer.line_events(commands[1]["line_id"])


async def _facade_write_then_read() -> tuple[list[dict], list[dict]]:
    ws = Workspace({"/ram": RAMResource()}, mode=MountMode.WRITE)
    await ws.ops.write("/ram/a.txt", b"hello")
    immediate = await ws.op_history()
    await asyncio.sleep(0)
    return immediate, await ws.op_history()


async def _records_and_line_id() -> tuple[list[str | None], str]:
    ws = await _ws_after("echo hi > /ram/x.txt")
    commands = await ws.observer.command_events()
    return [r.line_id for r in ws.ops.records], commands[0]["line_id"]


def test_op_events_are_reachable():
    _, ops = asyncio.run(
        _events_after("echo hi > /ram/x.txt", "cat /ram/x.txt"))
    assert [e["op"] for e in ops] == ["write", "read"]
    assert all(e["type"] == EVENT_OP for e in ops)


def test_op_history_mirrors_observer():
    history, events = asyncio.run(_op_history_and_op_events())
    assert history == events


def test_history_still_holds_commands_only():
    assert asyncio.run(_history_types()) == {EVENT_COMMAND}


def test_line_id_joins_ops_to_their_command():
    commands, ops = asyncio.run(
        _events_after("echo hi > /ram/x.txt", "cat /ram/x.txt"))
    first, second = commands[0]["line_id"], commands[1]["line_id"]
    assert first and second and first != second
    assert [e["line_id"] for e in ops] == [first, second]


def test_line_events_returns_the_ops_then_their_command():
    events = asyncio.run(_line_events_of_second_command())
    assert [e["type"] for e in events] == [EVENT_OP, EVENT_COMMAND]
    assert events[0]["op"] == "read"
    assert events[1]["command"] == "cat /ram/x.txt"


def test_nested_eval_ops_carry_the_top_level_line_id():
    commands, ops = asyncio.run(
        _events_after("echo hi > /ram/x.txt", "echo $(cat /ram/x.txt)"))
    assert [c["command"] for c in commands] == [
        "echo hi > /ram/x.txt",
        "echo $(cat /ram/x.txt)",
    ]
    assert [o["op"] for o in ops] == ["write", "read"]
    assert ops[1]["line_id"] == commands[1]["line_id"]


def test_a_facade_write_is_readable_without_yielding():
    immediate, after_yield = asyncio.run(_facade_write_then_read())
    assert [e["op"] for e in immediate] == ["write"]
    assert immediate == after_yield


def test_op_records_carry_the_line_id():
    line_ids, command_line_id = asyncio.run(_records_and_line_id())
    assert line_ids == [command_line_id]
