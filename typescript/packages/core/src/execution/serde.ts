// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { PathSpec } from '../types.ts'
import type { RecordFields } from '../workspace/record/types.ts'
import type { Line, LineState } from './line/types.ts'
import type { Process, ProcessState } from './process/types.ts'
import { LineId, MachineName, ProcessId } from './types.ts'

/** A line's record as a store or a snapshot keeps it. Mirrors Python's `line_to_fields`. */
export function lineToFields(record: Line): RecordFields {
  return {
    id: record.id.value,
    session_id: record.sessionId,
    command: record.command,
    started_at: record.startedAt,
    state: record.state,
    ended_at: record.endedAt,
    exit: record.exit,
    signal: record.signal,
    error: record.error,
  }
}

/** The line `lineToFields` wrote. */
export function lineFromFields(fields: RecordFields): Line {
  return {
    id: new LineId(fields.id as string),
    sessionId: fields.session_id as string,
    command: fields.command as string,
    startedAt: fields.started_at as number,
    state: fields.state as LineState,
    endedAt: (fields.ended_at as number | null | undefined) ?? null,
    exit: (fields.exit as number | null | undefined) ?? null,
    signal: (fields.signal as number | null | undefined) ?? null,
    error: (fields.error as string | null | undefined) ?? null,
  }
}

/** A process's record as a store or a snapshot keeps it. Mirrors Python's `process_to_fields`. */
export function processToFields(record: Process): RecordFields {
  const found = record.machinePid
  return {
    id: record.id.toString(),
    session_id: record.sessionId,
    line: record.line?.value ?? null,
    parent: record.parent,
    group: record.group,
    command: record.command,
    cwd: record.cwd.virtual,
    machine: record.machine.toString(),
    machine_instance: record.machineInstance ?? null,
    started_at: record.startedAt,
    program: record.program,
    machine_pid:
      found === null
        ? null
        : { pid: found.pid, started: found.started, exited: found.exited ?? null },
    state: record.state,
    ended_at: record.endedAt,
    exit: record.exit,
    signal: record.signal,
    error: record.error,
    ancestors: [...record.ancestors],
    stdin: record.stdin ?? null,
    fd: { ...record.fd },
    argv: [...(record.argv ?? [])],
  }
}

/** The process `processToFields` wrote. */
export function processFromFields(fields: RecordFields): Process {
  const found = fields.machine_pid as
    | {
        pid: number
        started: number
        exited?: number | null
      }
    | null
    | undefined
  const line = fields.line as string | null | undefined
  return {
    id: ProcessId.parse(fields.id as string),
    sessionId: fields.session_id as string,
    line: line === null || line === undefined ? null : new LineId(line),
    parent: (fields.parent as number | null | undefined) ?? null,
    group: fields.group as number,
    command: fields.command as string,
    cwd: PathSpec.fromStrPath(fields.cwd as string),
    machine: MachineName.parse(fields.machine as string),
    machineInstance: (fields.machine_instance as string | null | undefined) ?? null,
    startedAt: fields.started_at as number,
    program: fields.program === true,
    machinePid:
      found === null || found === undefined
        ? null
        : { pid: found.pid, started: found.started, exited: found.exited ?? null },
    state: fields.state as ProcessState,
    endedAt: (fields.ended_at as number | null | undefined) ?? null,
    exit: (fields.exit as number | null | undefined) ?? null,
    signal: (fields.signal as number | null | undefined) ?? null,
    error: (fields.error as string | null | undefined) ?? null,
    ancestors: (fields.ancestors as number[] | null | undefined) ?? [],
    stdin: (fields.stdin as number | null | undefined) ?? null,
    fd: Object.fromEntries(
      Object.entries((fields.fd as Record<string, number> | null | undefined) ?? {}).map(
        ([fd, pid]) => [Number(fd), pid],
      ),
    ),
    argv: (fields.argv as number[] | null | undefined) ?? [],
  }
}
