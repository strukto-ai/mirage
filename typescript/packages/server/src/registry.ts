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

import { newWorkspaceId, WorkspaceRunner, type Workspace } from '@struktoai/mirage-node'

export class WorkspaceEntry {
  readonly id: string
  readonly runner: WorkspaceRunner
  readonly createdAt: number

  constructor(id: string, runner: WorkspaceRunner) {
    this.id = id
    this.runner = runner
    this.createdAt = Date.now() / 1000
  }
}

export interface WorkspaceRegistryOptions {
  idleGraceSeconds?: number
  onIdleExit?: () => void
}

export class WorkspaceRegistry {
  private entries = new Map<string, WorkspaceEntry>()
  private readonly idleGraceSeconds: number
  private readonly onIdleExit: (() => void) | null
  private idleTimer: NodeJS.Timeout | null = null

  constructor(options: WorkspaceRegistryOptions = {}) {
    this.idleGraceSeconds = options.idleGraceSeconds ?? 30
    this.onIdleExit = options.onIdleExit ?? null
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  get(id: string): WorkspaceEntry {
    const e = this.entries.get(id)
    if (e === undefined) throw new Error(`workspace not found: ${id}`)
    return e
  }

  list(): WorkspaceEntry[] {
    return Array.from(this.entries.values())
  }

  size(): number {
    return this.entries.size
  }

  add(ws: Workspace, id?: string): WorkspaceEntry {
    const wid = id ?? newWorkspaceId()
    if (this.entries.has(wid)) throw new Error(`workspace id already exists: ${wid}`)
    const entry = new WorkspaceEntry(wid, new WorkspaceRunner(ws))
    this.entries.set(wid, entry)
    this.cancelIdleTimer()
    return entry
  }

  async remove(id: string): Promise<WorkspaceEntry> {
    const entry = this.entries.get(id)
    if (entry === undefined) throw new Error(`workspace not found: ${id}`)
    this.entries.delete(id)
    await entry.runner.stop()
    if (this.entries.size === 0) this.startIdleTimer()
    return entry
  }

  async closeAll(): Promise<void> {
    this.cancelIdleTimer()
    const ids = Array.from(this.entries.keys())
    for (const id of ids) {
      const entry = this.entries.get(id)
      this.entries.delete(id)
      if (entry !== undefined) await entry.runner.stop()
    }
  }

  private startIdleTimer(): void {
    if (this.onIdleExit === null) return
    if (this.idleGraceSeconds <= 0) {
      this.onIdleExit()
      return
    }
    if (this.idleTimer !== null) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.entries.size === 0 && this.onIdleExit !== null) this.onIdleExit()
    }, this.idleGraceSeconds * 1000)
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
