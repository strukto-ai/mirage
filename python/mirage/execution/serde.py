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


from typing import Any

from mirage.execution.line.types import Line, LineState
from mirage.execution.process.types import Process, ProcessState
from mirage.execution.types import LineId, MachineId, MachinePid, ProcessId
from mirage.types import PathSpec
from mirage.workspace.record.types import RecordFields


def line_to_fields(record: Line) -> RecordFields:
    """A line's record as a store or a snapshot keeps it.

    Args:
        record (Line): the line.
    """
    return {
        "id": record.id.value,
        "session_id": record.session_id,
        "command": record.command,
        "started_at": record.started_at,
        "state": record.state.value,
        "ended_at": record.ended_at,
        "exit": record.exit,
        "signal": record.signal,
        "error": record.error,
    }


def line_from_fields(fields: RecordFields) -> Line:
    """The line ``line_to_fields`` wrote.

    Args:
        fields (RecordFields): the line's fields.
    """
    return Line(
        id=LineId(fields["id"]),
        session_id=fields["session_id"],
        command=fields["command"],
        started_at=fields["started_at"],
        state=LineState(fields["state"]),
        ended_at=fields.get("ended_at"),
        exit=fields.get("exit"),
        signal=fields.get("signal"),
        error=fields.get("error"),
    )


def process_to_fields(record: Process) -> RecordFields:
    """A process's record as a store or a snapshot keeps it.

    Args:
        record (Process): the process.
    """
    found = record.machine_pid
    machine_pid: dict[str, Any] | None = (
        None
        if found is None
        else {
            "pid": found.pid,
            "started": found.started,
            "exited": found.exited,
        }
    )
    return {
        "id": str(record.id),
        "session_id": record.session_id,
        "line": record.line.value if record.line is not None else None,
        "parent": record.parent,
        "group": record.group,
        "command": record.command,
        "cwd": record.cwd.virtual,
        "machine": str(record.machine),
        "machine_instance": record.machine_instance,
        "started_at": record.started_at,
        "runtime": record.runtime,
        "machine_pid": machine_pid,
        "state": record.state.value,
        "ended_at": record.ended_at,
        "exit": record.exit,
        "signal": record.signal,
        "error": record.error,
        "ancestors": list(record.ancestors),
    }


def process_from_fields(fields: RecordFields) -> Process:
    """The process ``process_to_fields`` wrote.

    Args:
        fields (RecordFields): the process's fields.
    """
    found = fields.get("machine_pid")
    line = fields.get("line")
    return Process(
        id=ProcessId.parse(fields["id"]),
        session_id=fields["session_id"],
        line=LineId(line) if line is not None else None,
        parent=fields.get("parent"),
        group=fields["group"],
        command=fields["command"],
        cwd=PathSpec.from_str_path(fields["cwd"]),
        machine=MachineId.parse(fields["machine"]),
        machine_instance=fields.get("machine_instance"),
        started_at=fields["started_at"],
        runtime=fields.get("runtime"),
        machine_pid=(
            MachinePid(found["pid"], found["started"], found.get("exited"))
            if found is not None
            else None
        ),
        state=ProcessState(fields["state"]),
        ended_at=fields.get("ended_at"),
        exit=fields.get("exit"),
        signal=fields.get("signal"),
        error=fields.get("error"),
        ancestors=tuple(fields.get("ancestors") or ()),
    )
