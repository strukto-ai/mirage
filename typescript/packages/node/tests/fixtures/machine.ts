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

import { MachineTable } from '@struktoai/mirage-core/execution/machine/table'
import type { MachineHandle } from '@struktoai/mirage-core/machine/handle'
import type { RuntimeEntry } from '@struktoai/mirage-core/runtime/base'
import { RemoteRuntime } from '@struktoai/mirage-core/runtime/machine/runtime'

// One table per handle, as one workspace holds a handle however many
// runtimes a test binds to it.
const TABLES = new WeakMap<MachineHandle, MachineTable>()

/** A handle whose remote runtime captures `captures`, for a test. */
export function captured<T extends MachineHandle>(handle: T, captures: readonly string[]): T {
  ;(handle as { captures?: readonly string[] }).captures = captures
  return handle
}

/** What a test's fake handle says its runtime captures, undefined for a real one. */
function capturesOf(handle: MachineHandle): readonly string[] | undefined {
  return (handle as { captures?: readonly string[] }).captures
}

/**
 * A remote runtime on one machine, bound to it as a workspace binds its
 * entries, capturing what a fake handle's `captures` names. Mirrors
 * Python's `tests/fixtures/machine.machine_runtime`.
 */
export function machineRuntime(handle: MachineHandle): RemoteRuntime {
  const captures = capturesOf(handle)
  const runtime = new RemoteRuntime({
    machine: handle.name,
    ...(captures !== undefined ? { captures } : {}),
  })
  let table = TABLES.get(handle)
  if (table === undefined) {
    table = new MachineTable({ [handle.name]: handle })
    TABLES.set(handle, table)
  }
  runtime.bindMachines(table)
  return runtime
}

/**
 * The workspace options that run one machine's programs, capturing what a
 * fake handle's `captures` names, the other runtime entries after it.
 * Mirrors Python's `tests/fixtures/machine.on`.
 */
export function on(
  handle: MachineHandle,
  ...rest: RuntimeEntry[]
): { machines: Record<string, MachineHandle>; runtimes: RuntimeEntry[] } {
  const captures = capturesOf(handle)
  const entry = new RemoteRuntime({
    machine: handle.name,
    ...(captures !== undefined ? { captures } : {}),
  })
  return { machines: { [handle.name]: handle }, runtimes: [entry, ...rest] }
}
