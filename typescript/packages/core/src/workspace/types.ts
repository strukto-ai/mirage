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

import type { OpRecord } from '../observe/record.ts'
import type { PathSpec } from '../types.ts'

export interface ExecutionNodeInit {
  command?: string | null
  op?: string | null
  stderr?: Uint8Array
  exitCode?: number
  children?: ExecutionNode[]
  records?: OpRecord[]
  paths?: PathSpec[]
  refused?: boolean
  unopened?: boolean
}

export class ExecutionNode {
  command: string | null
  op: string | null
  stderr: Uint8Array
  exitCode: number
  children: ExecutionNode[]
  records: OpRecord[]
  // Classified path operands of a leaf mount command. Transient (not
  // serialized): lets the lazy-stream drain respell filesystem errors as
  // typed, like the eager chokepoint.
  paths: PathSpec[]
  // The admission gate refused the line, so it never ran. Transient:
  // the redirect layer reads it to leave output targets untouched,
  // where an ordinary failure still creates and truncates them as
  // bash's open-before-exec would.
  refused: boolean
  // A redirect target could not be opened, so the command never ran.
  // Transient: the ERR action answers a group or loop that fails this
  // way, which its own commands would have answered otherwise.
  unopened: boolean

  constructor(init: ExecutionNodeInit = {}) {
    this.command = init.command ?? null
    this.op = init.op ?? null
    this.stderr = init.stderr ?? new Uint8Array()
    this.exitCode = init.exitCode ?? 0
    this.children = init.children ?? []
    this.records = init.records ?? []
    this.paths = init.paths ?? []
    this.refused = init.refused ?? false
    this.unopened = init.unopened ?? false
  }

  toJSON(): Record<string, unknown> {
    const d: Record<string, unknown> = {}
    if (this.command !== null) d.command = this.command
    if (this.op !== null) d.op = this.op
    d.stderr = new TextDecoder('utf-8', { fatal: false }).decode(this.stderr)
    d.exitCode = this.exitCode
    if (this.children.length > 0) d.children = this.children.map((c) => c.toJSON())
    if (this.records.length > 0) d.records = this.records.map((r) => r.toJSON())
    return d
  }
}
