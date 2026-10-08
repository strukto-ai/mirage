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

import { type RouteDecision } from '../../runtime/routing/index.ts'
import type { Runtime, RuntimeEntry } from '../../runtime/base.ts'
import { rejectConfigScript } from './guard.ts'
import type { WorkspaceBinding } from '../../runtime/binding.ts'
import { isLineExecutor, type LineExecutor } from '../../runtime/mixin.ts'
import {
  bindCommands,
  buildRuntime,
  DEFAULT_ENTRIES,
  wholeLineRuntime,
} from '../../runtime/table.ts'
import { WorkspaceRuntime } from '../../runtime/workspace.ts'
import type { MountRegistry } from '../mount/registry.ts'

export interface RuntimesInit {
  registry: MountRegistry
  /** The `runtimes` option: instances and name shorthands, or undefined for the default world. */
  entries: RuntimeEntry[] | undefined
  binding: WorkspaceBinding
}

/**
 * The workspace's ordered runtime world; the first capturer binds each
 * command. Mirrors the Python `Runtimes` in `workspace/runtimes.py`.
 *
 * Owns the entry list and everything that reads or changes it: building
 * it from config, adding and removing entries, closing them, and
 * answering which entry takes a whole line.
 *
 * The TypeScript engines construct lazily (missing wasm surfaces at run
 * time), so defaults and explicit entries build the same way. The
 * workspace runtime is required: every world names an executor for
 * unclaimed commands, so an omitted entry appends the default
 * unconditional one.
 */
export class Runtimes {
  entries: readonly Runtime[] = []
  bindings: Record<string, Runtime> = Object.create(null) as Record<string, Runtime>
  private readonly registry: MountRegistry
  private readonly binding: WorkspaceBinding
  private readonly retiring = new Map<Runtime, Promise<void>>()

  constructor(init: RuntimesInit) {
    this.registry = init.registry
    this.binding = init.binding
    const entries: Runtime[] = (init.entries ?? DEFAULT_ENTRIES).map((entry) =>
      typeof entry === 'string' ? buildRuntime(entry) : entry,
    )
    if (!entries.some((entry) => entry.name === 'workspace')) {
      entries.push(new WorkspaceRuntime())
    }
    for (const entry of entries) {
      rejectConfigScript(`runtime '${entry.name}' script`, entry.script)
    }
    const bindings = bindCommands(entries)
    for (const entry of entries) entry.bind(this.binding)
    this.install(entries, bindings)
  }

  /**
   * Append a runtime entry to the ordered world.
   *
   * The entry lands last, so it never steals a command an earlier entry
   * already captures (first capturer still wins). A name builds like a
   * config entry and fails loud; a duplicate name is rejected before
   * any state changes.
   */
  add(runtime: RuntimeEntry): Runtime {
    const entry: Runtime = typeof runtime === 'string' ? buildRuntime(runtime) : runtime
    rejectConfigScript(`runtime '${entry.name}' script`, entry.script)
    const candidate = [...this.entries, entry]
    const bindings = bindCommands(candidate)
    entry.bind(this.binding)
    this.install(candidate, bindings)
    return entry
  }

  /** Unbind an entry's commands now and close it once it is idle. */
  async remove(name: string): Promise<void> {
    if (name === 'workspace') {
      throw new Error(
        'cannot remove the workspace runtime: it serves every command no other runtime captures',
      )
    }
    const entry = this.entries.find((candidate) => candidate.name === name)
    if (entry === undefined) throw new Error(`no runtime entry: '${name}'`)
    const remaining = this.entries.filter((candidate) => candidate !== entry)
    this.install(remaining, bindCommands(remaining))
    const closing = retire(entry).finally(() => {
      this.retiring.delete(entry)
    })
    this.retiring.set(entry, closing)
    await closing
  }

  /** Close every entry, including the ones still being removed. */
  async close(): Promise<void> {
    const results = await Promise.allSettled([
      ...this.entries.map((entry) => entry.close()),
      ...this.retiring.values(),
    ])
    const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []))
    if (failures.length > 0)
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, 'runtime close failed')
  }

  private install(entries: readonly Runtime[], bindings: Record<string, Runtime>): void {
    this.entries = entries
    this.bindings = bindings
    this.registry.runtimeEntries = entries
    this.registry.workspaceRuntime =
      entries.find((entry): entry is WorkspaceRuntime => entry instanceof WorkspaceRuntime) ?? null
  }

  /**
   * The runtime taking this whole line, null for the executor.
   *
   * A runtime carrying LineExecutor takes the raw line when the line's
   * resolved bindings explicitly place "*" on it;
   * everything else walks the executor's tree. The common world has no
   * such runtime, so this is a cheap scan.
   */
  wholeLineFor(decision: RouteDecision | null): (Runtime & LineExecutor) | null {
    const candidates = this.entries.some((entry) => isLineExecutor(entry))
    if (!candidates) return null
    const bindings: Record<string, Runtime | null> =
      decision !== null ? decision.bindings : this.bindings
    return wholeLineRuntime(bindings)
  }
}

async function retire(entry: Runtime): Promise<void> {
  await entry.retire()
  await entry.close()
}
