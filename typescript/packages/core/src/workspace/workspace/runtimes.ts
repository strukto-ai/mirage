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

import { parsedCommands, type PolicyDecision } from '../executor/policy/index.ts'
import {
  bindCommands,
  DEFAULT_ENTRIES,
  scriptStringError,
  VfsRuntime,
  wholeLineRuntime,
  type Runtime,
  type RuntimeEntry,
} from '../executor/runtime.ts'
import { buildRuntime } from '../executor/runtime_table.ts'
import type { BridgeDispatchFn } from '../executor/python/mirage_bridge.ts'
import type { TSNodeLike } from '../expand/variable.ts'
import type { MountRegistry } from '../mount/registry.ts'

export interface RuntimesInit {
  registry: MountRegistry
  /** The `runtimes` option: instances and name shorthands, or undefined for the default world. */
  entries: RuntimeEntry[] | undefined
  /** `options.python`, forwarded into the default pyodide build. */
  pythonConfig: Record<string, unknown>
  bridge: () => BridgeDispatchFn
  visibleMounts: () => string[]
  lineExecutor: (
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ) => Promise<{ stdout: Uint8Array; stderr: Uint8Array | null; exitCode: number }>
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
  private readonly bridge: () => BridgeDispatchFn
  private readonly visibleMounts: () => string[]
  private readonly registerCloser: (fn: () => Promise<void>) => void

  constructor(init: RuntimesInit) {
    this.registry = init.registry
    this.bridge = init.bridge
    this.visibleMounts = init.visibleMounts
    this.registerCloser = init.registerCloser
    if (init.entries === undefined) {
      for (const name of DEFAULT_ENTRIES) {
        this.entries.push(
          buildRuntime(name, name === 'pyodide' ? { config: { ...init.pythonConfig } } : {}),
        )
      }
    } else {
      for (const entry of init.entries) {
        this.entries.push(typeof entry === 'string' ? buildRuntime(entry) : entry)
      }
    }
    if (!this.entries.some((entry) => entry.name === 'vfs')) {
      this.entries.push(new VfsRuntime())
    }
    init.registry.vfsRuntime = this.entries.find((entry) => entry instanceof VfsRuntime) ?? null
    if (init.registry.vfsRuntime instanceof VfsRuntime) {
      init.registry.vfsRuntime.bindLineExecutor(init.lineExecutor)
    }
    for (const entry of this.entries) {
      if (typeof entry.script === 'string')
        throw scriptStringError(`runtime '${entry.name}' script`)
      entry.attach(this.bridge(), this.visibleMounts)
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
    if (typeof entry.script === 'string') throw scriptStringError(`runtime '${entry.name}' script`)
    const candidate = [...this.entries, entry]
    const bindings = bindCommands(candidate)
    entry.attach(this.bridge(), this.visibleMounts)
    this.registerCloser(() => entry.close())
    this.entries.push(entry)
    this.bindings = bindings
    return entry
  }

  /**
   * The runtime taking this whole line, null for the executor.
   *
   * A runtime with runsLines takes the raw line when the line's
   * resolved bindings place one of its commands (or "*") on it;
   * everything else walks the executor's tree. The common world has no
   * such runtime, so this is a cheap scan.
   */
  wholeLineFor(rootNode: TSNodeLike, decision: PolicyDecision | null): Runtime | null {
    const candidates = this.entries.some(
      (entry) => entry.runsLines && !(entry instanceof VfsRuntime),
    )
    if (!candidates) return null
    const bindings: Record<string, Runtime | null> =
      decision !== null ? decision.bindings : this.bindings
    const commands = parsedCommands(rootNode, this.registry.clis.names())
    return wholeLineRuntime(
      bindings,
      commands.map((parsed) => parsed.command),
    )
  }
}
