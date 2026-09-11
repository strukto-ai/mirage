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
import type { Resource } from '../../resource/base.ts'
import type { JobTable } from '../../shell/job_table/index.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { WorkspaceStateStore } from '../store/base.ts'
import type { WatchManager } from './watch.ts'

export interface CloseDeps {
  watch: WatchManager
  cache: FileCache & Resource
  ownsStateStore: boolean
  stateStore: WorkspaceStateStore
  closers: (() => Promise<void>)[]
  jobTable: JobTable
  registry: MountRegistry
  opened: Set<Resource>
  openOrder: Resource[]
  sharedResources: Set<Resource>
}

/**
 * Release everything the workspace owns, exactly once (the caller
 * guards re-entry). Mirrors the Python `close_async` in
 * `workspace/lifecycle.py`.
 *
 * Order matters: the watch runtime goes first (it reads mounts), then
 * background jobs, then the runtime closers (their journals still write
 * to mounts), then in-flight cache drains settle, then the state store if
 * this workspace built it, and finally every resource not shared with a
 * sibling workspace.
 */
export async function closeWorkspace(deps: CloseDeps): Promise<void> {
  await deps.watch.detach()
  // Settle jobs rather than merely aborting them: killAll records the
  // outcome and finishes each console, which is what releases a reader
  // parked on waitFinished; a bare abort leaves the job RUNNING with no
  // ending chunk and that reader waits forever. It never joins the
  // runner, so this cannot block shutdown on a job mid-write, and it
  // happens before any resource closes so a job cannot keep touching one
  // that is already gone.
  await deps.jobTable.killAll()
  await deps.jobTable.closeConsoles()
  // Runtimes next, and before the cache or any resource closes. A runtime
  // that was interrupted mid-run still has a journal to replay, and that
  // replay writes to mounts: draining it after the cache had gone made every
  // one of those writes fail with "Workspace is closed", so a python program
  // killed by its timeout silently lost its last mutations. Python has always
  // ordered it this way (`close_async` closes line runtimes before resources).
  for (const fn of deps.closers.splice(0)) {
    try {
      await fn()
    } catch {
      // keep tearing down; swallow subsystem-cleanup failures
    }
  }
  const retirements = await Promise.allSettled([...deps.registry.retiringResources.values()])
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
  const toClose = new Set<Resource>(deps.openOrder)
  for (const mount of deps.registry.allMounts()) {
    toClose.add(mount.resource)
  }
  for (const r of toClose) {
    // Resources reused from another live workspace (copy() / load
    // resource overrides) stay open here; their origin closes them.
    if (deps.sharedResources.has(r)) continue
    await r.close()
  }
  deps.opened.clear()
  deps.openOrder.length = 0
}
