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

import pytest

from mirage.server.logs import completed_logs, log_lines, log_page


def test_equal_timestamps_and_unfinished_commands():
    records = []
    for ident in ("a", "c", "b"):
        records.append(
            {
                "type": "command",
                "id": ident,
                "command": ident,
                "session": "s",
                "timestamp": 1000,
            }
        )
        if ident != "c":
            records.append(
                {
                    "type": "vfs",
                    "parent": ident,
                    "session": "s",
                    "timestamp": 1007,
                    "vfs": "read",
                    "path": "/a",
                    "source": "ram",
                    "bytes": 2,
                    "duration_ms": 2,
                }
            )
            records.append(
                {
                    "type": "result",
                    "parent": ident,
                    "session": "s",
                    "timestamp": 1010,
                    "duration_ms": 10,
                    "exit_code": 0,
                    "stdout": "",
                    "stderr": "",
                }
            )
    logs = completed_logs(records)
    first = log_page(logs, "1", None)
    assert [item.id for item in first.items] == ["b"]
    assert first.items[0].started_at == 1000
    assert first.items[0].mounts[0].started_at == 1005
    assert first.next is not None
    second = log_page(logs, "1", first.next)
    assert [item.id for item in second.items] == ["a"]
    assert second.next is None
    exported = [json.loads(line) for line in log_lines(logs)]
    assert [
        event["id"] for event in exported if event["type"] == "command"
    ] == ["a", "b"]


@pytest.mark.parametrize(
    "cursor", ["bad", "WzAsdHJ1ZV0=", "e30=", "bnVsbA==", "WzBd"]
)
def test_invalid_cursor_is_a_query_error(cursor):
    with pytest.raises(ValueError, match="after is not a cursor"):
        log_page([], "50", cursor)
