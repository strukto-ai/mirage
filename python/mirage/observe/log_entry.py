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

EVENT_VFS = "vfs"
EVENT_COMMAND = "command"
EVENT_CLEAR = "clear"
EVENT_DELETE = "delete"
STDOUT_TRUNCATE = 4096


@dataclass
class LogEntry:
    """Unified log entry for vfs calls, commands, and history control events.

    Args:
        type (str): One of EVENT_VFS, EVENT_COMMAND, EVENT_CLEAR,
            EVENT_DELETE.
        session (str): Session ID.
        timestamp (int): UTC epoch milliseconds.
        vfs (str | None): The vfs call, such as read or write (for
            type="vfs").
        path (str | None): Virtual path (for type="vfs").
        source (str | None): VFS name (for type="vfs").
        bytes (int | None): Bytes transferred (for type="vfs").
        duration_ms (int | None): Duration in ms (for type="vfs").
        command (str | None): Shell command (for type="command").
        exit_code (int | None): Exit code (for type="command").
        stdout (str | None): Truncated stdout (for type="command").
        offset (int | None): 1-based listing position (for
            type="delete"); negative counts back from the end.
    """

    type: str
    session: str
    timestamp: int
    cwd: str | None = None
    vfs: str | None = None
    path: str | None = None
    source: str | None = None
    bytes: int | None = None
    duration_ms: int | None = None
    command: str | None = None
    exit_code: int | None = None
    stdout: str | None = None
    offset: int | None = None
    execution_id: str | None = None

    @staticmethod
    def from_op_record(
        rec: OpRecord,
        session: str,
        cwd: str | None = None,
    ) -> "LogEntry":
        """Create a LogEntry from an OpRecord.

        Args:
            rec (OpRecord): The operation record.
                session (str): Session ID.
            cwd (str | None): Session cwd at log time.

        Returns:
            LogEntry: Unified log entry.
        """
        return LogEntry(
            type=EVENT_VFS,
            session=session,
            timestamp=rec.timestamp,
            cwd=cwd,
            vfs=rec.op,
            path=rec.path,
            source=rec.source,
            bytes=rec.bytes,
            duration_ms=rec.duration_ms,
            execution_id=rec.execution_id,
        )

    def to_json_line(self) -> str:
        d = {k: v for k, v in asdict(self).items() if v is not None}
        return json.dumps(d, separators=(",", ":"))
