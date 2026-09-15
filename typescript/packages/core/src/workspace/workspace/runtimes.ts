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
  DEFAULT_PYTHON,
  VFSRuntime,
  wholeLineRuntime,
} from '../../runtime/table.ts'
import type { MountRegistry } from '../mount/registry.ts'

export interface RuntimesInit {
  registry: MountRegistry
  /** The `runtimes` option: instances and name shorthands, or undefined for the default world. */
  entries: RuntimeEntry[] | undefined
  /** `options.python`, forwarded into the default python engine's build. */
  pythonConfig: Record<string, unknown>
  binding: WorkspaceBinding
  registerCloser: (fn: () => Promise<void>) => void
}

/**
 * The workspace's ordered runtime world; the first capturer binds each
 * command. Mirrors the Python `Runtimes` in `workspace/runtimes.py`.
 *
 * The TypeScript engines construct lazily (missing wasm surfaces at run
 * time), so defaults and explicit entries build the same way. The vfs
 * runtime is required: every world names an executor for unclaimed
 * commands, so an omitted entry appends the default unconditional one.
 */
export class Runtimes {
  readonly entries: Runtime[] = []
  bindings: Record<string, Runtime>
  private readonly registry: MountRegistry
  private readonly binding: WorkspaceBinding
  private readonly registerCloser: (fn: () => Promise<void>) => void

  constructor(init: RuntimesInit) {
    this.registry = init.registry
    this.binding = init.binding
    this.registerCloser = init.registerCloser
    if (init.entries === undefined) {
      for (const name of DEFAULT_ENTRIES) {
        this.entries.push(
          buildRuntime(name, name === DEFAULT_PYTHON ? { config: { ...init.pythonConfig } } : {}),
        )
      }
    } else {
      for (const entry of init.entries) {
        this.entries.push(typeof entry === 'string' ? buildRuntime(entry) : entry)
      }
    }
    if (!this.entries.some((entry) => entry.name === 'vfs')) {
      this.entries.push(new VFSRuntime())
    }
    init.registry.vfsRuntime =
      this.entries.find((entry): entry is VFSRuntime => entry instanceof VFSRuntime) ?? null
    // The live array: add() pushes into it, so the registry view never
    // goes stale (Python re-assigns per add instead).
    init.registry.runtimeEntries = this.entries
    for (const entry of this.entries) {
      rejectConfigScript(`runtime '${entry.name}' script`, entry.script)
      entry.bind(this.binding)
      this.registerCloser(() => entry.close())
    }
    this.bindings = bindCommands(this.entries)
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
    this.registerCloser(() => entry.close())
    this.entries.push(entry)
    this.bindings = bindings
    return entry
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
