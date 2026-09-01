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
from dataclasses import asdict, dataclass

from mirage.observe.record import OpRecord

EVENT_OP = "op"
EVENT_COMMAND = "command"
EVENT_CLEAR = "clear"
EVENT_DELETE = "delete"
STDOUT_TRUNCATE = 4096


@dataclass
class LogEntry:
    """Unified log entry for ops, commands, and history control events.

    Args:
        type (str): One of EVENT_OP, EVENT_COMMAND, EVENT_CLEAR,
            EVENT_DELETE.
        agent (str): Agent ID.
        session (str): Session ID.
        timestamp (int): UTC epoch milliseconds.
        op (str | None): Operation name (for type="op").
        path (str | None): Virtual path (for type="op").
        source (str | None): Resource name (for type="op").
        bytes (int | None): Bytes transferred (for type="op").
        duration_ms (int | None): Duration in ms (for type="op").
        command (str | None): Shell command (for type="command").
        exit_code (int | None): Exit code (for type="command").
        stdout (str | None): Truncated stdout (for type="command").
        offset (int | None): 1-based listing position (for
            type="delete"); negative counts back from the end.
        line_id (str | None): The typed line this event belongs to. An
            op event and the command event it ran under carry the same
            value, which is what joins them.
    """

    type: str
    agent: str
    session: str
    timestamp: int
    cwd: str | None = None
    op: str | None = None
    path: str | None = None
    source: str | None = None
    bytes: int | None = None
    duration_ms: int | None = None
    command: str | None = None
    exit_code: int | None = None
    stdout: str | None = None
    offset: int | None = None
    line_id: str | None = None

    @staticmethod
    def from_op_record(
        rec: OpRecord,
        agent: str,
        session: str,
        cwd: str | None = None,
    ) -> "LogEntry":
        """Create a LogEntry from an OpRecord.

        Args:
            rec (OpRecord): The operation record.
            agent (str): Agent ID.
            session (str): Session ID.
            cwd (str | None): Session cwd at log time.

        Returns:
            LogEntry: Unified log entry.
        """
        return LogEntry(
            type=EVENT_OP,
            agent=agent,
            session=session,
            timestamp=rec.timestamp,
            cwd=cwd,
            op=rec.op,
            path=rec.path,
            source=rec.source,
            bytes=rec.bytes,
            duration_ms=rec.duration_ms,
            line_id=rec.line_id,
        )

    def to_json_line(self) -> str:
        d = {k: v for k, v in asdict(self).items() if v is not None}
        return json.dumps(d, separators=(",", ":"))
