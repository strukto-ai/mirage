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
import json
import logging

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

from mirage import MountMode, Workspace
from mirage.io import IOResult
from mirage.observe import OpRecord
from mirage.observe import observer as observer_module
from mirage.observe.constants import (
    TRACE_CONTENT_ENV,
    TRACE_CONTENT_MAX_BYTES,
    TRACE_CONTENT_MAX_BYTES_ENV,
    TRACE_MAX_SPANS_ENV,
)
from mirage.observe.disk_store import DiskObserverStore
from mirage.observe.log_entry import EVENT_COMMAND, LogEntry
from mirage.observe.observer import Observer
from mirage.observe.store import RAMObserverStore
from mirage.policy import ExecuteResultContext, Policy
from mirage.utils.clock import ManualClock
from mirage.vfs.ram import RAMVFS

NEW_YEAR = 1_609_459_200.0


def test_log_op_writes_jsonl():
    store = RAMObserverStore()
    obs = Observer(store=store, clock=ManualClock(start=NEW_YEAR))
    rec = OpRecord(
        op="read",
        path="/data/f.csv",
        source="s3",
        bytes=100,
        timestamp=int(NEW_YEAR * 1000),
        duration_ms=5,
    )
    asyncio.run(obs.log_op(rec, session="sess-1"))
    data = store.files["/2021-01-01/sess-1.jsonl"]
    parsed = json.loads(data.decode().strip())
    assert parsed["type"] == "vfs"
    assert parsed["session"] == "sess-1"
    assert parsed["vfs"] == "read"


def test_a_line_writes_its_command_then_its_result():
    store = RAMObserverStore()
    clock = ManualClock(start=NEW_YEAR + 1.5)
    obs = Observer(store=store, clock=clock)
    asyncio.run(obs.log_command("ls /data", "sess-1", line="L"))
    clock.advance(2)
    io = IOResult(stdout=b"file.csv\n", stderr=b"ls: warn\n", exit_code=1)
    asyncio.run(obs.log_result(io, [], "sess-1", line="L"))
    data = store.files["/2021-01-01/sess-1.jsonl"]
    command, result = (json.loads(x) for x in data.decode().splitlines())
    assert command == {
        "type": "command",
        "session": "sess-1",
        "timestamp": 1_609_459_201_500,
        "id": "L",
        "command": "ls /data",
    }
    assert result == {
        "type": "result",
        "session": "sess-1",
        "timestamp": 1_609_459_203_500,
        "parent": "L",
        "duration_ms": 2000,
        "exit_code": 1,
        "stdout": "file.csv\n",
        "stderr": "ls: warn\n",
    }


def test_a_line_joins_the_listing_when_its_result_is_in():
    obs = Observer()
    asyncio.run(obs.log_command("sleep 1", "s1", line="L"))
    assert asyncio.run(obs.session_command_events("s1")) == []
    assert asyncio.run(obs.command_events()) == []
    asyncio.run(obs.log_result(IOResult(), [], "s1", line="L"))
    assert [
        e["command"] for e in asyncio.run(obs.session_command_events("s1"))
    ] == ["sleep 1"]
    assert [e["command"] for e in asyncio.run(obs.command_events())] == [
        "sleep 1"
    ]


def test_a_long_line_lets_the_loop_run_while_it_logs():
    obs = Observer(store=RAMObserverStore(), clock=ManualClock(start=NEW_YEAR))
    rec = OpRecord(
        op="read",
        path="/f",
        source="ram",
        bytes=1,
        timestamp=int(NEW_YEAR * 1000),
        duration_ms=1,
    )

    async def run() -> int:
        turns = 0

        async def other() -> None:
            nonlocal turns
            while True:
                turns += 1
                await asyncio.sleep(0)

        task = asyncio.create_task(other())
        records = [rec] * 10_000
        await obs.log_result(IOResult(), records, "s")
        task.cancel()
        return turns

    assert asyncio.run(run()) > 0


def test_multiple_entries_appended():
    store = RAMObserverStore()
    obs = Observer(store=store, clock=ManualClock(start=NEW_YEAR))
    for i in range(3):
        rec = OpRecord(
            op="read",
            path=f"/f{i}",
            source="s3",
            bytes=i,
            timestamp=int(NEW_YEAR * 1000) + i,
            duration_ms=1,
        )
        asyncio.run(obs.log_op(rec, session="s"))
    data = store.files["/2021-01-01/s.jsonl"]
    lines = data.decode().strip().split("\n")
    assert len(lines) == 3


def _log_command(obs: Observer, command: str, session: str, ts: float) -> None:
    entry = LogEntry(
        type=EVENT_COMMAND,
        session=session,
        timestamp=int(ts * 1000),
        command=command,
        exit_code=0,
    )
    asyncio.run(obs._log(entry))


def test_default_store_is_ram():
    obs = Observer()
    assert isinstance(obs.store, RAMObserverStore)


def test_log_clear_appends_tombstone():
    obs = Observer()
    asyncio.run(obs.log_clear(session="s1"))
    events = asyncio.run(obs.events())
    assert events[-1]["type"] == "clear"
    assert events[-1]["session"] == "s1"


def test_command_events_all_sessions_timestamp_order():
    obs = Observer()
    _log_command(obs, "ls /a", "s2", 1.0)
    _log_command(obs, "ls /b", "s1", 2.0)
    op = OpRecord(
        op="read",
        path="/f",
        source="ram",
        bytes=0,
        timestamp=1500,
        duration_ms=1,
    )
    asyncio.run(obs.log_op(op, session="s1"))
    events = asyncio.run(obs.command_events())
    assert [e["command"] for e in events] == ["ls /a", "ls /b"]
    assert all(e["type"] == "command" for e in events)


def test_session_same_timestamp_keeps_append_order():
    obs = Observer()
    _log_command(obs, "first", "s1", 1.0)
    _log_command(obs, "second", "s1", 1.0)
    _log_command(obs, "third", "s1", 1.0)
    events = asyncio.run(obs.session_command_events("s1"))
    assert [e["command"] for e in events] == ["first", "second", "third"]


def test_session_command_events_respects_last_clear():
    obs = Observer()
    _log_command(obs, "cmd A", "s1", 1.0)
    asyncio.run(obs.log_clear(session="s1"))
    _log_command(obs, "cmd B", "s1", 2.0)
    _log_command(obs, "cmd C", "s2", 3.0)
    s1 = asyncio.run(obs.session_command_events("s1"))
    s2 = asyncio.run(obs.session_command_events("s2"))
    assert [e["command"] for e in s1] == ["cmd B"]
    assert [e["command"] for e in s2] == ["cmd C"]


def test_load_events_restores_and_resumes():
    obs = Observer()
    _log_command(obs, "old", "s1", 1.0)
    events = asyncio.run(obs.events())
    restored = Observer()
    asyncio.run(restored.load_events(events))
    _log_command(restored, "new", "s1", 2.0)
    out = asyncio.run(restored.command_events())
    assert [e["command"] for e in out] == ["old", "new"]


def test_log_command_text_appends_single_entry():
    obs = Observer()
    asyncio.run(obs.log_command_text("a b c", session="s1"))
    events = asyncio.run(obs.session_command_events("s1"))
    assert [e["command"] for e in events] == ["a b c"]
    assert "id" not in events[0]


def test_delete_event_removes_entry_and_renumbers():
    obs = Observer()
    _log_command(obs, "one", "s1", 1.0)
    _log_command(obs, "two", "s1", 2.0)
    _log_command(obs, "three", "s1", 3.0)
    asyncio.run(obs.log_delete(session="s1", offset=2))
    events = asyncio.run(obs.session_command_events("s1"))
    assert [e["command"] for e in events] == ["one", "three"]


def test_delete_negative_offset_counts_from_end():
    obs = Observer()
    _log_command(obs, "one", "s1", 1.0)
    _log_command(obs, "two", "s1", 2.0)
    asyncio.run(obs.log_delete(session="s1", offset=-1))
    events = asyncio.run(obs.session_command_events("s1"))
    assert [e["command"] for e in events] == ["one"]


def test_delete_applies_at_issue_time_position():
    obs = Observer()
    _log_command(obs, "one", "s1", 1.0)
    asyncio.run(obs.log_delete(session="s1", offset=1))
    _log_command(obs, "two", "s1", 2.0)
    events = asyncio.run(obs.session_command_events("s1"))
    assert [e["command"] for e in events] == ["two"]


def test_clear_discards_earlier_deletes():
    obs = Observer()
    _log_command(obs, "one", "s1", 1.0)
    asyncio.run(obs.log_delete(session="s1", offset=1))
    asyncio.run(obs.log_clear(session="s1"))
    _log_command(obs, "two", "s1", 2.0)
    events = asyncio.run(obs.session_command_events("s1"))
    assert [e["command"] for e in events] == ["two"]


def test_load_events_rewinds_pre_restore_timeline():
    src = Observer()
    _log_command(src, "snap-cmd", "snap", 2.0)
    snapshot_events = asyncio.run(src.events())
    obs = Observer()
    _log_command(obs, "old-live", "live", 1.0)
    asyncio.run(obs.load_events(snapshot_events))
    out = asyncio.run(obs.command_events())
    assert [e["command"] for e in out] == ["snap-cmd"]
    assert {e["session"] for e in asyncio.run(obs.events())} == {"snap"}


def test_load_events_empty_snapshot_still_clears():
    obs = Observer()
    _log_command(obs, "old", "s1", 1.0)
    asyncio.run(obs.load_events([]))
    assert asyncio.run(obs.events()) == []


def test_load_events_skips_foreign_format_entries():
    obs = Observer()
    foreign = {
        "command": "cat /a | wc -l",
        "stdout": b"5\n",
        "tree": {"command": "cat /a | wc -l", "children": []},
        "session_id": "default",
    }
    native = {"type": EVENT_COMMAND, "session": "s1", "command": "echo hi"}
    asyncio.run(obs.load_events([foreign, native]))
    events = asyncio.run(obs.command_events())
    assert [e["command"] for e in events] == ["echo hi"]


def test_a_clock_behind_stored_history_does_not_reorder_it():
    store = RAMObserverStore()
    first = Observer(store=store, clock=ManualClock(start=NEW_YEAR))
    asyncio.run(first.log_command_text("a", session="s"))
    asyncio.run(first.log_command_text("b", session="s"))
    reopened = Observer(store=store, clock=ManualClock())
    asyncio.run(reopened.log_delete("s", 1))
    shown = asyncio.run(reopened.session_command_events("s"))
    assert [e["command"] for e in shown] == ["b"]
    asyncio.run(reopened.log_clear("s"))
    asyncio.run(reopened.log_command_text("c", session="s"))
    shown = asyncio.run(reopened.session_command_events("s"))
    assert [e["command"] for e in shown] == ["c"]
    events = asyncio.run(reopened.events())
    assert [e["type"] for e in events] == [
        "command",
        "command",
        "delete",
        "clear",
        "command",
    ]
    assert list(store.files) == ["/2021-01-01/s.jsonl"]


def test_a_clock_behind_restored_history_does_not_reorder_it():
    snapshot = [
        {
            "type": "command",
            "session": "s",
            "timestamp": int(NEW_YEAR * 1000),
            "command": "a",
            "exit_code": 0,
        }
    ]
    restored = Observer(clock=ManualClock())
    asyncio.run(restored.load_events(snapshot))
    asyncio.run(restored.log_clear("s"))
    assert asyncio.run(restored.session_command_events("s")) == []


class _NoScanStore(RAMObserverStore):
    async def read_all(self) -> dict[str, bytes]:
        raise AssertionError("read every session's history")


def test_the_floor_reads_only_the_entry_s_session():
    store = _NoScanStore()
    first = Observer(store=store, clock=ManualClock(start=NEW_YEAR))
    asyncio.run(first.log_command_text("a", session="s"))
    asyncio.run(first.log_command_text("x", session="t"))
    reopened = Observer(store=store, clock=ManualClock())
    asyncio.run(reopened.log_clear("s"))
    assert asyncio.run(reopened.session_command_events("s")) == []
    shown = asyncio.run(reopened.session_command_events("t"))
    assert [e["command"] for e in shown] == ["x"]


def test_an_empty_history_sets_no_floor():
    obs = Observer(clock=ManualClock(start=-1.0))
    asyncio.run(obs.log_command_text("a", session="s"))
    events = asyncio.run(obs.events())
    assert [e["timestamp"] for e in events] == [-1000]


def test_a_torn_line_costs_only_itself_and_the_entry_appended_onto_it(
    caplog,
):
    store = RAMObserverStore()
    obs = Observer(store=store, clock=ManualClock(start=NEW_YEAR))
    _log_command(obs, "first", "s1", NEW_YEAR)
    [path] = store.files
    torn = b'{"type": "command", "session": "s1", "command": "caf\xc3'
    asyncio.run(store.append(path, torn))
    _log_command(obs, "second", "s1", NEW_YEAR + 1)
    _log_command(obs, "third", "s1", NEW_YEAR + 2)
    shown = asyncio.run(obs.session_command_events("s1"))
    assert [e["command"] for e in shown] == ["first", "third"]
    with caplog.at_level(logging.DEBUG, logger="mirage.observe.observer"):
        every = asyncio.run(obs.command_events())
    assert [e["command"] for e in every] == ["first", "third"]
    assert f"skipping unparseable history line in {path}" in caplog.text


def test_an_entry_whose_command_holds_a_line_separator_is_kept():
    store = RAMObserverStore()
    obs = Observer(store=store, clock=ManualClock(start=NEW_YEAR))
    _log_command(obs, "first", "s1", NEW_YEAR)
    [path] = store.files
    raw = (
        '{"type": "command", "session": "s1", "timestamp": 1609459201000, '
        '"command": "a\u2028b\u0085c"}\n'
    )
    asyncio.run(store.append(path, raw.encode()))
    shown = asyncio.run(obs.session_command_events("s1"))
    assert [e["command"] for e in shown] == ["first", "a\u2028b\u0085c"]


def test_a_session_id_names_one_flat_log():
    store = RAMObserverStore()
    obs = Observer(store=store, clock=ManualClock(start=NEW_YEAR))
    for session in ("s1", "team/s1", "../x"):
        asyncio.run(obs.log_command_text(f"echo {session}", session))
    assert sorted(store.files) == [
        "/2021-01-01/..%2Fx.jsonl",
        "/2021-01-01/s1.jsonl",
        "/2021-01-01/team%2Fs1.jsonl",
    ]
    listed = asyncio.run(obs.session_command_events("s1"))
    assert [e["command"] for e in listed] == ["echo s1"]


def test_a_long_session_id_records_under_a_bounded_name(tmp_path):
    store = DiskObserverStore(str(tmp_path))
    obs = Observer(store=store, clock=ManualClock(start=NEW_YEAR))
    long, longer = "\u00e9" * 50, "\u00e9" * 51
    for session in (long, longer):
        asyncio.run(obs.log_command_text(f"echo {len(session)}", session))
    names = [p.name for p in (tmp_path / "2021-01-01").iterdir()]
    assert len(names) == 2
    assert all(len(name.encode()) <= 255 for name in names)
    listed = asyncio.run(obs.session_command_events(long))
    assert [e["command"] for e in listed] == ["echo 50"]


def _exported(monkeypatch) -> InMemorySpanExporter:
    """Send the observer's spans to memory, to read back."""
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(
        observer_module, "_tracer", lambda: provider.get_tracer("t")
    )
    return exporter


def test_a_finished_line_is_a_span_over_its_vfs_calls(monkeypatch):
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(
        observer_module, "_tracer", lambda: provider.get_tracer("t")
    )
    clock = ManualClock(start=NEW_YEAR)
    obs = Observer(store=RAMObserverStore(), clock=clock, workspace_id="w")
    start = int(NEW_YEAR * 1000)
    rec = OpRecord(
        op="read",
        path="/d/a",
        source="s3",
        bytes=6,
        timestamp=start + 5,
        duration_ms=12,
    )
    asyncio.run(obs.log_command("cat /d/a", "s1", cwd="/d", line="L"))
    clock.advance(1)
    io = IOResult(
        stdout=b"x" * 20000,
        stderr=b"cat: /d/b: No such file\n",
        exit_code=1,
    )
    # The line ends in another cwd; the span keeps the one it started in.
    asyncio.run(obs.log_result(io, [rec], "s1", cwd="/", line="L"))
    call, line = exporter.get_finished_spans()
    assert (line.name, dict(line.attributes or {})) == (
        "command",
        {
            "mirage.workspace.id": "w",
            "mirage.session.id": "s1",
            "mirage.command": "cat /d/a",
            "mirage.exit_code": 1,
            "mirage.timestamp": start,
            "mirage.duration_ms": 1000,
            "mirage.stdout": "x" * TRACE_CONTENT_MAX_BYTES,
            "mirage.stderr": "cat: /d/b: No such file\n",
            "mirage.cwd": "/d",
        },
    )
    assert (line.start_time, line.end_time) == (
        start * 1_000_000,
        (start + 1000) * 1_000_000,
    )
    assert call.parent is not None
    assert call.parent.span_id == line.context.span_id
    assert (call.name, dict(call.attributes or {})) == (
        "vfs.read",
        {
            "mirage.vfs.path": "/d/a",
            "mirage.vfs.source": "s3",
            "mirage.vfs.bytes": 6,
            "mirage.vfs.timestamp": start + 5,
            "mirage.vfs.duration_ms": 12,
        },
    )
    assert (call.start_time, call.end_time) == (
        (start - 7) * 1_000_000,
        (start + 5) * 1_000_000,
    )
    # The history keeps its own, shorter cut.
    results = [e for e in asyncio.run(obs.events()) if e["type"] == "result"]
    assert [len(e["stdout"]) for e in results] == [4096]


def test_span_output_is_cut_at_the_bytes_it_is_told_to(monkeypatch):
    monkeypatch.setenv(TRACE_CONTENT_MAX_BYTES_ENV, "5")
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(
        observer_module, "_tracer", lambda: provider.get_tracer("t")
    )
    obs = Observer(store=RAMObserverStore(), clock=ManualClock(start=NEW_YEAR))
    asyncio.run(obs.log_command("echo", "s1", cwd="/", line="L"))
    # Two bytes a character: five bytes end inside the third, which is
    # left out rather than shown as U+FFFD.
    io = IOResult(stdout="ééé".encode())
    asyncio.run(obs.log_result(io, [], "s1", cwd="/", line="L"))
    [line] = exporter.get_finished_spans()
    assert (line.attributes or {})["mirage.stdout"] == "éé"


def test_a_line_sends_at_most_its_span_cap_and_counts_the_rest(monkeypatch):
    monkeypatch.setenv(TRACE_MAX_SPANS_ENV, "2")
    exporter = _exported(monkeypatch)
    obs = Observer(store=RAMObserverStore(), clock=ManualClock(start=NEW_YEAR))
    start = int(NEW_YEAR * 1000)
    recs = [
        OpRecord(
            op="stat",
            path=f"/d/{i}",
            source="ram",
            bytes=0,
            timestamp=start,
            duration_ms=0,
        )
        for i in range(5)
    ]
    asyncio.run(obs.log_command("find /d", "s1", cwd="/", line="L"))
    asyncio.run(obs.log_result(IOResult(), recs, "s1", cwd="/", line="L"))
    *calls, line = exporter.get_finished_spans()
    assert [c.attributes["mirage.vfs.path"] for c in calls] == ["/d/0", "/d/1"]
    assert (line.attributes or {})["mirage.vfs.dropped"] == 3
    # The history still records every call.
    vfs = [e for e in asyncio.run(obs.events()) if e["type"] == "vfs"]
    assert len(vfs) == 5


def test_span_output_that_is_not_utf8_stays_within_its_bytes(monkeypatch):
    exporter = _exported(monkeypatch)
    obs = Observer(store=RAMObserverStore(), clock=ManualClock(start=NEW_YEAR))
    asyncio.run(obs.log_command("cat blob", "s1", cwd="/", line="L"))
    # Each byte reads as U+FFFD, three bytes in UTF-8.
    limit = TRACE_CONTENT_MAX_BYTES
    io = IOResult(stdout=b"\xff" * limit)
    asyncio.run(obs.log_result(io, [], "s1", cwd="/", line="L"))
    [line] = exporter.get_finished_spans()
    assert (line.attributes or {})["mirage.stdout"] == "\ufffd" * (limit // 3)


class _SeesOutput(Policy):
    async def post_execute(self, ctx: ExecuteResultContext) -> None:
        return None


@pytest.mark.asyncio
async def test_a_span_keeps_the_cwd_a_line_was_given(monkeypatch):
    exporter = _exported(monkeypatch)
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        # A post_execute policy has the line recorded whole, as one entry.
        ws.policies.add(_SeesOutput())
        await ws.shell("pwd", cwd="/data")
        history = await ws.history()
    finally:
        await ws.close()
    [line] = [s for s in exporter.get_finished_spans() if s.name == "command"]
    assert (line.attributes or {})["mirage.cwd"] == "/data"
    assert [e["cwd"] for e in history] == ["/data", "/data"]


@pytest.mark.asyncio
async def test_a_span_takes_output_past_the_terminal_chunk(monkeypatch):
    monkeypatch.setenv(TRACE_CONTENT_MAX_BYTES_ENV, "20000")
    exporter = _exported(monkeypatch)
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("seq 1 10000")
        history = await ws.history()
    finally:
        await ws.close()
    [line] = [s for s in exporter.get_finished_spans() if s.name == "command"]
    assert len(str((line.attributes or {})["mirage.stdout"])) == 20000
    # The history keeps its own cut.
    results = [e for e in history if e["type"] == "result"]
    assert [len(e["stdout"]) for e in results] == [4096]


def test_spans_leave_out_output_and_vfs_calls_when_told_to(monkeypatch):
    monkeypatch.setenv(TRACE_CONTENT_ENV, "false")
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(
        observer_module, "_tracer", lambda: provider.get_tracer("t")
    )
    obs = Observer(
        store=RAMObserverStore(),
        clock=ManualClock(start=NEW_YEAR),
        workspace_id="w",
    )
    rec = OpRecord(
        op="read",
        path="/d/a",
        source="s3",
        bytes=6,
        timestamp=int(NEW_YEAR * 1000),
        duration_ms=1,
    )
    asyncio.run(obs.log_command("cat /d/a", "s1", cwd="/d", line="L"))
    io = IOResult(stdout=b"secret\n")
    asyncio.run(obs.log_result(io, [rec], "s1", cwd="/d", line="L"))
    assert [
        (s.name, dict(s.attributes or {}))
        for s in exporter.get_finished_spans()
    ] == [
        (
            "command",
            {
                "mirage.workspace.id": "w",
                "mirage.session.id": "s1",
                "mirage.command": "cat /d/a",
                "mirage.exit_code": 0,
                "mirage.timestamp": int(NEW_YEAR * 1000),
                "mirage.duration_ms": 0,
                "mirage.cwd": "/d",
            },
        )
    ]
    # The history itself still keeps the output.
    results = [e for e in asyncio.run(obs.events()) if e["type"] == "result"]
    assert [e["stdout"] for e in results] == ["secret\n"]


def test_bash_history_lists_lines_in_the_order_they_ended():
    clock = ManualClock(start=NEW_YEAR)
    obs = Observer(store=RAMObserverStore(), clock=clock)
    asyncio.run(obs.log_command("sleep 9", "s1", line="slow"))
    clock.advance(1)
    asyncio.run(obs.log_command("echo quick", "s2", line="quick"))
    clock.advance(1)
    asyncio.run(obs.log_result(IOResult(), [], "s2", line="quick"))
    clock.advance(1)
    asyncio.run(obs.log_result(IOResult(), [], "s1", line="slow"))
    asyncio.run(obs.log_result(IOResult(), [], "s1", line="slow"))
    assert [e["command"] for e in asyncio.run(obs.command_events())] == [
        "echo quick",
        "sleep 9",
    ]
    results = [e for e in asyncio.run(obs.events()) if e["type"] == "result"]
    assert [(e["parent"], e["duration_ms"]) for e in results] == [
        ("quick", 1000),
        ("slow", 3000),
    ]
