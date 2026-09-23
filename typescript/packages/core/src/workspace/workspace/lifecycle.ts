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

import type { FileCache } from '../../cache/file/mixin.ts'
import type { VFS } from '../../vfs/base.ts'
import type { JobTable } from '../../shell/job_table/index.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { WorkspaceStateStore } from '../store/base.ts'
import type { WatchManager } from './watch.ts'

export interface CloseDeps {
  watch: WatchManager
  cache: FileCache & VFS
  ownsStateStore: boolean
  stateStore: WorkspaceStateStore
  closers: (() => Promise<void>)[]
  jobTable: JobTable
  registry: MountRegistry
  opened: Set<VFS>
  openOrder: VFS[]
  sharedMounts: Set<VFS>
}

/**
 * Release everything the workspace owns, exactly once (the caller
 * guards re-entry). Mirrors the Python `close_async` in
 * `workspace/lifecycle.py`.
 *
 * Order matters: the watch runtime goes first (it reads mounts), then
 * background jobs, then the runtime closers (their journals still write
 * to mounts), then in-flight cache drains settle, then the state store if
 * this workspace built it, and finally every VFS not shared with a
 * sibling workspace.
 */
export async function closeWorkspace(deps: CloseDeps): Promise<void> {
  await deps.watch.detach()
  // Settle jobs rather than merely aborting them: killAll records the
  // outcome and finishes each console, which is what releases a reader
  // parked on waitFinished; a bare abort leaves the job RUNNING with no
  // ending chunk and that reader waits forever. It never joins the
  // runner, so this cannot block shutdown on a job mid-write, and it
  // happens before any VFS closes so a job cannot keep touching one
  // that is already gone.
  await deps.jobTable.killAll()
  await deps.jobTable.closeConsoles()
  // Runtimes next, and before the cache or any VFS closes. A runtime
  // that was interrupted mid-run still has a journal to replay, and that
  // replay writes to mounts: draining it after the cache had gone made every
  // one of those writes fail with "Workspace is closed", so a python program
  // killed by its timeout silently lost its last mutations. Python has always
  // ordered it this way (`close_async` closes line runtimes before mounts).
  // Collected rather than thrown here: the rest of teardown still has to
  // run, but a failed replay is the data-loss signal above going quiet
  // again, so it is raised once everything is released. The rest runs
  // inside a catch for the same reason -- a later stage that rejects
  // would otherwise carry this loss back out of sight.
  const failures: unknown[] = []
  for (const fn of deps.closers.splice(0)) {
    try {
      await fn()
    } catch (err) {
      failures.push(err)
    }
  }
  try {
    const retirements = await Promise.allSettled([...deps.registry.retiringMounts.values()])
    for (const result of retirements) {
      if (result.status === 'rejected') throw result.reason as Error
    }
    const drainTasks = [...(deps.cache.drainTasks?.values() ?? [])]
    for (const task of drainTasks) {
      await task
    }
    // Per-plane stores from the provider close through it below; a
    // caller-passed provider (or direct store override) may be shared
    // with sibling workspaces, so only its owner closes it.
    if (deps.ownsStateStore) {
      await deps.stateStore.close()
    }
    try {
      await deps.cache.clear()
    } finally {
      // The workspace builds its own cache, so it always closes it: a
      // `cache: {type: redis}` config leaves it holding a client that
      // nothing else would release, and clear() above connects to it.
      // Mirrors the try/finally pairing in Python's `close_async`.
      await deps.cache.close()
    }
    const toClose = new Set<VFS>(deps.openOrder)
    for (const mount of deps.registry.allMounts()) {
      toClose.add(mount.vfs)
    }
    for (const r of toClose) {
      // mounts reused from another live workspace (copy() / load
      // VFS overrides) stay open here; their origin closes them.
      if (deps.sharedMounts.has(r)) continue
      await r.close()
    }
    deps.opened.clear()
    deps.openOrder.length = 0
  } catch (err) {
    failures.push(err)
  }
  if (failures.length > 0) throw teardownFailure(failures)
}

function teardownFailure(failures: unknown[]): Error {
  if (failures.length === 1) return failures[0] as Error
  return new AggregateError(failures, 'workspace teardown failed')
}
