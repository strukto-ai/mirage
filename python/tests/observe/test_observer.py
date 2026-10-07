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

from mirage.io import IOResult
from mirage.observe import OpRecord
from mirage.observe.log_entry import EVENT_COMMAND, LogEntry
from mirage.observe.observer import Observer
from mirage.observe.store import RAMObserverStore
from mirage.utils.dates import utc_date_folder


def test_log_op_writes_jsonl():
    store = RAMObserverStore()
    obs = Observer(store=store)
    rec = OpRecord(
        op="read",
        path="/data/f.csv",
        source="s3",
        bytes=100,
        timestamp=1000,
        duration_ms=5,
    )
    asyncio.run(obs.log_op(rec, agent="agent-1", session="sess-1"))
    data = store.files[f"/{utc_date_folder()}/sess-1.jsonl"]
    parsed = json.loads(data.decode().strip())
    assert parsed["type"] == "op"
    assert parsed["agent"] == "agent-1"
    assert parsed["session"] == "sess-1"
    assert parsed["op"] == "read"


def test_log_execution_writes_jsonl():
    store = RAMObserverStore()
    obs = Observer(store=store)
    io = IOResult(stdout=b"file.csv\n")
    asyncio.run(
        obs.log_execution(
            "ls /data", io, [], agent="agent-1", session="sess-1"
        )
    )
    data = store.files[f"/{utc_date_folder()}/sess-1.jsonl"]
    parsed = json.loads(data.decode().strip())
    assert parsed["type"] == "command"
    assert parsed["session"] == "sess-1"
    assert parsed["command"] == "ls /data"
    assert parsed["stdout"] == "file.csv\n"
    assert parsed["exit_code"] == 0


def test_multiple_entries_appended():
    store = RAMObserverStore()
    obs = Observer(store=store)
    for i in range(3):
        rec = OpRecord(
            op="read",
            path=f"/f{i}",
            source="s3",
            bytes=i,
            timestamp=1000 + i,
            duration_ms=1,
        )
        asyncio.run(obs.log_op(rec, agent="a", session="s"))
    data = store.files[f"/{utc_date_folder()}/s.jsonl"]
    lines = data.decode().strip().split("\n")
    assert len(lines) == 3


def _log_command(obs: Observer, command: str, session: str, ts: float) -> None:
    entry = LogEntry(
        type=EVENT_COMMAND,
        agent="a",
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
    asyncio.run(obs.log_clear(session="s1", agent="a1"))
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
    asyncio.run(obs.log_op(op, agent="a", session="s1"))
    events = asyncio.run(obs.command_events())
    assert [e["command"] for e in events] == ["ls /a", "ls /b"]
    assert all(e["type"] == "command" for e in events)


def test_history_filters_exact_session_before_applying_edits():
    obs = Observer()
    _log_command(obs, "own", "alice", 1.0)
    _log_command(obs, "foreign", "team/alice", 2.0)
    asyncio.run(obs.log_delete(session="team/alice", offset=1, agent="a"))
    asyncio.run(obs.log_clear(session="team/alice", agent="a"))
    _log_command(obs, "foreign after clear", "team/alice", 3.0)

    assert [
        e["command"] for e in asyncio.run(obs.command_events("alice"))
    ] == ["own"]
    assert [
        e["command"] for e in asyncio.run(obs.session_command_events("alice"))
    ] == ["own"]
    assert [
        e["command"] for e in asyncio.run(obs.command_events("team/alice"))
    ] == ["foreign", "foreign after clear"]
    assert [
        e["command"]
        for e in asyncio.run(obs.session_command_events("team/alice"))
    ] == ["foreign after clear"]


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
    asyncio.run(obs.log_clear(session="s1", agent="a"))
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
    assert events[0]["exit_code"] == 0


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
        "agent": "default",
        "command": "cat /a | wc -l",
        "stdout": b"5\n",
        "tree": {"command": "cat /a | wc -l", "children": []},
        "session_id": "default",
    }
    native = {"type": EVENT_COMMAND, "session": "s1", "command": "echo hi"}
    asyncio.run(obs.load_events([foreign, native]))
    events = asyncio.run(obs.command_events())
    assert [e["command"] for e in events] == ["echo hi"]
