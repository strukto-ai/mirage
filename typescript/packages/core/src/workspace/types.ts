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

  constructor(init: ExecutionNodeInit = {}) {
    this.command = init.command ?? null
    this.op = init.op ?? null
    this.stderr = init.stderr ?? new Uint8Array()
    this.exitCode = init.exitCode ?? 0
    this.children = init.children ?? []
    this.records = init.records ?? []
    this.paths = init.paths ?? []
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

export interface ExecutionRecordInit {
  agent: string
  command: string
  stdout: Uint8Array
  stdin?: Uint8Array | null
  exitCode: number
  tree: ExecutionNode
  timestamp: number
  sessionId?: string
}

export class ExecutionRecord {
  readonly agent: string
  readonly command: string
  readonly stdout: Uint8Array
  readonly stdin: Uint8Array | null
  readonly exitCode: number
  readonly tree: ExecutionNode
  readonly timestamp: number
  readonly sessionId: string

  constructor(init: ExecutionRecordInit) {
    this.agent = init.agent
    this.command = init.command
    this.stdout = init.stdout
    this.stdin = init.stdin ?? null
    this.exitCode = init.exitCode
    this.tree = init.tree
    this.timestamp = init.timestamp
    this.sessionId = init.sessionId ?? ''
  }

  toJSON(): Record<string, unknown> {
    const decoder = new TextDecoder('utf-8', { fatal: false })
    return {
      agent: this.agent,
      command: this.command,
      stdout: decoder.decode(this.stdout),
      stdin: this.stdin === null ? null : decoder.decode(this.stdin),
      exitCode: this.exitCode,
      tree: this.tree.toJSON(),
      timestamp: this.timestamp,
      sessionId: this.sessionId,
    }
  }
}
