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

import type { OpRecord } from './record.ts'

export const EVENT_VFS = 'vfs'
export const EVENT_COMMAND = 'command'
export const EVENT_RESULT = 'result'
export const EVENT_CLEAR = 'clear'
export const EVENT_DELETE = 'delete'
export const STDOUT_TRUNCATE = 4096

export type EventType = 'vfs' | 'command' | 'result' | 'clear' | 'delete'

export interface LogEntryInit {
  type: EventType
  session: string
  timestamp: number
  cwd?: string
  id?: string
  parent?: string
  vfs?: string
  path?: string
  source?: string
  bytes?: number
  durationMs?: number
  command?: string
  exitCode?: number
  stdout?: string
  stderr?: string
  offset?: number
}

/**
 * Unified log entry for commands, their vfs calls and results, and
 * history control events. A line is a `command` entry written when it
 * starts, with its `id`, then a `vfs` entry for each call it made to a
 * mount and a `result` entry when it ends, both naming it as their
 * `parent`. Mirrors Python's `LogEntry`.
 */
export class LogEntry {
  readonly type: EventType
  readonly session: string
  readonly timestamp: number
  readonly cwd: string | undefined
  readonly id: string | undefined
  readonly parent: string | undefined
  readonly vfs: string | undefined
  readonly path: string | undefined
  readonly source: string | undefined
  readonly bytes: number | undefined
  readonly durationMs: number | undefined
  readonly command: string | undefined
  readonly exitCode: number | undefined
  readonly stdout: string | undefined
  readonly stderr: string | undefined
  readonly offset: number | undefined

  constructor(init: LogEntryInit) {
    this.type = init.type
    this.session = init.session
    this.timestamp = init.timestamp
    this.cwd = init.cwd
    this.id = init.id
    this.parent = init.parent
    this.vfs = init.vfs
    this.path = init.path
    this.source = init.source
    this.bytes = init.bytes
    this.durationMs = init.durationMs
    this.command = init.command
    this.exitCode = init.exitCode
    this.stdout = init.stdout
    this.stderr = init.stderr
    this.offset = init.offset
  }

  static fromOpRecord(rec: OpRecord, session: string, cwd?: string, parent?: string): LogEntry {
    const init: LogEntryInit = {
      type: EVENT_VFS,
      session,
      timestamp: rec.timestamp,
      vfs: rec.op,
      path: rec.path,
      source: rec.source,
      bytes: rec.bytes,
      durationMs: rec.durationMs,
    }
    if (cwd !== undefined) init.cwd = cwd
    if (parent !== undefined) init.parent = parent
    return new LogEntry(init)
  }

  toJsonLine(): string {
    const obj: Record<string, unknown> = {
      type: this.type,
      session: this.session,
      timestamp: this.timestamp,
    }
    if (this.cwd !== undefined) obj.cwd = this.cwd
    if (this.id !== undefined) obj.id = this.id
    if (this.parent !== undefined) obj.parent = this.parent
    if (this.vfs !== undefined) obj.vfs = this.vfs
    if (this.path !== undefined) obj.path = this.path
    if (this.source !== undefined) obj.source = this.source
    if (this.bytes !== undefined) obj.bytes = this.bytes
    if (this.durationMs !== undefined) obj.duration_ms = this.durationMs
    if (this.command !== undefined) obj.command = this.command
    if (this.exitCode !== undefined) obj.exit_code = this.exitCode
    if (this.stdout !== undefined) obj.stdout = this.stdout
    if (this.stderr !== undefined) obj.stderr = this.stderr
    if (this.offset !== undefined) obj.offset = this.offset
    return JSON.stringify(obj)
  }
}
