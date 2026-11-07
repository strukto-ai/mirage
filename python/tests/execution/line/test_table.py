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

from mirage.execution.line.handle import LineHandle
from mirage.execution.line.table import LineTable
from mirage.execution.types import LineId
from mirage.utils.clock import ManualClock


def _line(table: LineTable, name: str, session_id: str = "s") -> LineHandle:
    line = LineHandle(LineId(name), session_id, name, now=table.clock.now)
    table.start(line)
    return line


def test_the_table_lists_lines_by_session():
    table = LineTable(ManualClock())
    first = _line(table, "a", "s1")
    _line(table, "b", "s2")
    assert [line.id for line in table.lines()] == [LineId("a"), LineId("b")]
    assert [line.id for line in table.lines("s1")] == [LineId("a")]
    assert table.get(LineId("a")) == first.record
    assert table.get(LineId("missing")) is None


def test_only_the_newest_ended_lines_are_kept(monkeypatch):
    monkeypatch.setattr("mirage.execution.line.table.HISTORY_MAX_RECORDS", 1)
    clock = ManualClock()
    table = LineTable(clock)
    old, running = _line(table, "old"), _line(table, "running")
    old.end(0)
    clock.advance(1)
    new = _line(table, "new")
    new.end(0)
    assert [line.id for line in table.lines()] == [running.id, new.id]


def test_ended_lines_go_after_an_hour():
    clock = ManualClock()
    table = LineTable(clock)
    line = _line(table, "a")
    line.end(0)
    clock.advance(3601)
    assert table.get(line.id) is None
