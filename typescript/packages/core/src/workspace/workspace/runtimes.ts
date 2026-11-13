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

import type { MachineTable } from '../../execution/machine/table.ts'
import type { Runtime } from '../../runtime/base.ts'
import type { WorkspaceBinding } from '../../runtime/binding.ts'
import { LanguageRuntime } from '../../runtime/language.ts'
import { RemoteRuntime } from '../../runtime/machine/runtime.ts'
import {
  bindCommands,
  buildEntry,
  builtFrom,
  isSandbox,
  shadowedCaptures,
  type MachineSpec,
} from '../../runtime/table.ts'
import { WorkspaceRuntime } from '../../runtime/workspace.ts'
import type { MountRegistry } from '../mount/registry.ts'

/** Set `warn` to receive the captures another runtime shadows. */
export const logger: { warn?: (message: string) => void } = {}

/**
 * The runtime each of the workspace's machines runs, in capture order; the
 * first capturer binds each command. Mirrors the Python `Runtimes` in
 * `workspace/runtimes.py`.
 *
 * Owns the entry list and everything that reads or changes it: wiring it,
 * adding and removing machines and closing them. The shell is required:
 * every world names an executor for unclaimed commands, so an omitted one
 * appends the default unconditional one.
 */
export class Runtimes {
  entries: readonly Runtime[] = []
  private readonly registry: MountRegistry
  private readonly binding: WorkspaceBinding
  /** The machines a machine entry runs its programs on. */
  readonly machines: MachineTable
  private readonly retiring = new Map<Runtime, Promise<void>>()

  constructor(init: {
    registry: MountRegistry
    /** The runtime of each machine, in capture order. */
    entries: readonly Runtime[]
    binding: WorkspaceBinding
    /** The machines a machine entry runs on. */
    machines: MachineTable
  }) {
    this.registry = init.registry
    this.binding = init.binding
    this.machines = init.machines
    const entries: Runtime[] = [...init.entries]
    if (!entries.some((entry) => entry.name === 'workspace')) {
      entries.push(new WorkspaceRuntime())
    }
    const bindings = bindCommands(entries)
    for (const entry of entries) this.bindEntry(entry)
    this.install(entries, bindings)
  }

  /**
   * Add a machine's runtime to the ordered world.
   *
   * A sandbox (`isSandbox`) lands after the last sandbox listed, else before
   * the first language runtime, else last; any other entry lands last. A
   * duplicate name is rejected before any state changes; a machine
   * provider's handle is the workspace's to hold from the start.
   */
  add(name: string, spec: MachineSpec): Runtime {
    const [handle, entry] = buildEntry(name, spec)
    if (handle !== null)
      throw new Error(
        `machine '${name}': a ${handle.provider} machine is declared when the workspace is built`,
      )
    let at = this.entries.length
    if (isSandbox(entry)) {
      const lastSandbox = this.entries.reduce((last, e, i) => (isSandbox(e) ? i : last), -1)
      const firstLanguage = this.entries.findIndex((e) => e instanceof LanguageRuntime)
      if (lastSandbox >= 0) at = lastSandbox + 1
      else if (firstLanguage >= 0) at = firstLanguage
    }
    const candidate = [...this.entries.slice(0, at), entry, ...this.entries.slice(at)]
    const bindings = bindCommands(candidate)
    this.bindEntry(entry)
    this.install(candidate, bindings)
    return entry
  }

  /** The `machines:` entries of the runtimes built from one, by name, in list order; a copy rebuilds these. */
  specs(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {}
    for (const entry of this.entries) {
      const spec = builtFrom(entry)
      if (spec !== undefined) out[entry.name] = spec
    }
    return out
  }

  /**
   * Bind an entry to the workspace, and a machine one to its machines once
   * the workspace has it, so an entry another workspace holds keeps its own.
   *
   * Throws:
   *   Error: a machine entry's machine is not the workspace's, or another
   *   workspace holds the entry.
   */
  private bindEntry(entry: Runtime): void {
    const onMachine = entry instanceof RemoteRuntime
    if (onMachine) this.machines.get(entry.defaultMachine)
    entry.bind(this.binding)
    if (onMachine) entry.bindMachines(this.machines)
  }

  /** Unbind an entry's commands now and close it once it is idle. */
  async remove(name: string): Promise<void> {
    if (name === 'workspace') {
      throw new Error(
        'cannot remove the workspace machine: it serves every command no other machine captures',
      )
    }
    const entry = this.entries.find((candidate) => candidate.name === name)
    if (entry === undefined) throw new Error(`no machine: '${name}'`)
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
    const routed = this.registry.policies.hasPlacement()
    for (const [capture, winner, shadowed] of routed ? [] : shadowedCaptures(entries)) {
      logger.warn?.(
        `machine '${shadowed}' runs '${capture}' only when a route names it: '${winner}', listed before it, takes it`,
      )
    }
    this.entries = entries
    this.registry.runtimeEntries = entries
    this.registry.runtimeBindings = bindings
  }
}

async function retire(entry: Runtime): Promise<void> {
  await entry.retire()
  await entry.close()
}
