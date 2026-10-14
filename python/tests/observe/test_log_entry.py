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

from mirage.observe import LogEntry, OpRecord
from mirage.observe.log_entry import EVENT_COMMAND


def test_from_op_record():
    rec = OpRecord(
        op="read",
        path="/data/file.csv",
        source="s3",
        bytes=1024,
        timestamp=1712145600000,
        duration_ms=45,
    )
    entry = LogEntry.from_op_record(rec, session="sess-1")
    assert entry.type == "op"
    assert entry.session == "sess-1"
    assert entry.op == "read"
    assert entry.path == "/data/file.csv"
    assert entry.source == "s3"
    assert entry.bytes == 1024
    assert entry.duration_ms == 45


def _command_entry(cwd: str | None = None) -> LogEntry:
    return LogEntry(
        type=EVENT_COMMAND,
        session="s",
        timestamp=1000,
        cwd=cwd,
        command="ls",
        exit_code=0,
        stdout="out",
    )


def test_to_json_line_op():
    rec = OpRecord(
        op="read",
        path="/f.csv",
        source="s3",
        bytes=100,
        timestamp=1000,
        duration_ms=5,
    )
    entry = LogEntry.from_op_record(rec, session="s")
    line = entry.to_json_line()
    parsed = json.loads(line)
    assert parsed["type"] == "op"
    assert parsed["op"] == "read"
    assert "command" not in parsed


def test_to_json_line_command():
    entry = _command_entry()
    line = entry.to_json_line()
    parsed = json.loads(line)
    assert parsed["type"] == "command"
    assert parsed["command"] == "ls"
    assert "op" not in parsed


def test_log_entry_includes_cwd_for_op():
    rec = OpRecord(
        op="read",
        path="/f.csv",
        source="s3",
        bytes=100,
        timestamp=1000,
        duration_ms=5,
    )
    entry = LogEntry.from_op_record(rec, session="s", cwd="/data")
    parsed = json.loads(entry.to_json_line())
    assert parsed["cwd"] == "/data"


def test_log_entry_includes_cwd_for_command():
    entry = _command_entry(cwd="/data")
    parsed = json.loads(entry.to_json_line())
    assert parsed["cwd"] == "/data"


def test_log_entry_omits_cwd_when_not_provided():
    rec = OpRecord(
        op="read",
        path="/f.csv",
        source="s3",
        bytes=100,
        timestamp=1000,
        duration_ms=5,
    )
    entry = LogEntry.from_op_record(rec, session="s")
    parsed = json.loads(entry.to_json_line())
    assert "cwd" not in parsed
