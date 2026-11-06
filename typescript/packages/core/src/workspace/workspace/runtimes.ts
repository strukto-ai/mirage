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

import type { Runtime, RuntimeEntry } from '../../runtime/base.ts'
import type { WorkspaceBinding } from '../../runtime/binding.ts'
import { LanguageRuntime } from '../../runtime/language.ts'
import {
  bindCommands,
  buildRuntime,
  DEFAULT_ENTRIES,
  isSandbox,
  shadowedCaptures,
} from '../../runtime/table.ts'
import { WorkspaceRuntime } from '../../runtime/workspace.ts'
import type { MountRegistry } from '../mount/registry.ts'

/** Where a capture that never wins is reported; set `warn` to receive it. */
export const logger: { warn?: (message: string) => void } = {}

/**
 * The workspace's ordered runtime world; the first capturer binds each
 * command. Mirrors the Python `Runtimes` in `workspace/runtimes.py`.
 *
 * Owns the entry list and everything that reads or changes it: building
 * it from config, adding and removing entries and closing them.
 *
 * The TypeScript engines construct lazily (missing wasm surfaces at run
 * time), so defaults and explicit entries build the same way. The
 * workspace runtime is required: every world names an executor for
 * unclaimed commands, so an omitted entry appends the default
 * unconditional one.
 */
export class Runtimes {
  entries: readonly Runtime[] = []
  private readonly registry: MountRegistry
  private readonly binding: WorkspaceBinding
  private readonly retiring = new Map<Runtime, Promise<void>>()

  constructor(init: {
    registry: MountRegistry
    /** The `runtimes` option: instances and name shorthands, or undefined for the default world. */
    entries: RuntimeEntry[] | undefined
    binding: WorkspaceBinding
  }) {
    this.registry = init.registry
    this.binding = init.binding
    const entries: Runtime[] = (init.entries ?? DEFAULT_ENTRIES).map((entry) =>
      typeof entry === 'string' ? buildRuntime(entry) : entry,
    )
    if (!entries.some((entry) => entry.name === 'workspace')) {
      entries.push(new WorkspaceRuntime())
    }
    const bindings = bindCommands(entries)
    for (const entry of entries) entry.bind(this.binding)
    this.install(entries, bindings)
  }

  /**
   * Add a runtime entry to the ordered world.
   *
   * A sandbox (`isSandbox`) lands after the last sandbox listed, else before
   * the first language runtime, else last; any other entry lands last. A
   * name builds like a config entry and fails loud; a duplicate name is
   * rejected before any state changes.
   */
  add(runtime: RuntimeEntry): Runtime {
    const entry: Runtime = typeof runtime === 'string' ? buildRuntime(runtime) : runtime
    let at = this.entries.length
    if (isSandbox(entry)) {
      const lastSandbox = this.entries.reduce((last, e, i) => (isSandbox(e) ? i : last), -1)
      const firstLanguage = this.entries.findIndex((e) => e instanceof LanguageRuntime)
      if (lastSandbox >= 0) at = lastSandbox + 1
      else if (firstLanguage >= 0) at = firstLanguage
    }
    const candidate = [...this.entries.slice(0, at), entry, ...this.entries.slice(at)]
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
    for (const [capture, winner, shadowed] of shadowedCaptures(entries)) {
      logger.warn?.(
        `runtime '${shadowed}' never runs '${capture}': '${winner}', listed before it, takes it`,
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
