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
import type { BaseVFS } from '../../vfs/base.ts'
import type { JobTable } from '../../shell/job_table/index.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { SessionManager } from '../session/manager.ts'
import type { WorkspaceStateStore } from '../store/base.ts'
import { ABORT_JOIN_MS } from '../../utils/abort.ts'
import type { WatchManager } from './watch.ts'

export interface CloseDeps {
  watch: WatchManager
  cache: FileCache & BaseVFS
  ownsStateStore: boolean
  stateStore: WorkspaceStateStore
  closers: (() => Promise<void>)[]
  jobTable: JobTable
  sessions: SessionManager
  registry: MountRegistry
  sharedMounts: Set<BaseVFS>
  /** Delete the workspace's state from its store before the store closes. */
  dropState: boolean
  workspaceId: string
  /** The stores the workspace's state lives in, however they were wired. */
  planes: { clear(): Promise<void> }[]
}

/**
 * Release everything the workspace owns, exactly once (the caller
 * guards re-entry). Mirrors the Python `close_async` in
 * `workspace/lifecycle.py`.
 *
 * Order matters: the watch runtime goes first (it reads mounts), then
 * background jobs, then the runtime closers (their journals still write
 * to mounts), then the state store if this workspace built it, and
 * finally every VFS not shared with a sibling workspace.
 */
export async function closeWorkspace(deps: CloseDeps): Promise<void> {
  const failures: unknown[] = []
  const settle = async (work: (() => Promise<unknown>)[]): Promise<void> => {
    const outcomes = await Promise.allSettled(work.map(async (fn) => fn()))
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') failures.push(outcome.reason)
    }
  }
  await settle([() => deps.watch.detach()])
  await settle([() => deps.jobTable.killAll()])
  try {
    deps.jobTable.processes.stop()
  } catch (err) {
    failures.push(err)
  }
  for (const closer of deps.closers.splice(0)) await settle([closer])
  await settle([
    async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          deps.jobTable.processes.drain(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, ABORT_JOIN_MS)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    },
  ])
  await settle([() => deps.jobTable.closeConsoles()])
  await settle([...deps.registry.retiringMounts.values()].map((task) => () => task))
  const mounts = new Set(deps.registry.allMounts().map((mount) => mount.vfs))
  await settle(
    [...mounts].filter((vfs) => !deps.sharedMounts.has(vfs)).map((vfs) => () => vfs.close()),
  )
  const stores = new Set(deps.registry.allMounts().map((mount) => mount.indexStore))
  await settle([...stores].map((store) => () => store.close()))
  // Nothing writes the state any more, so it can go before its store
  // closes. A failed drop must not skip the rest of teardown; it is raised
  // with the other failures once everything is released.
  if (deps.dropState) {
    await settle([
      async () => {
        for (const plane of deps.planes) await plane.clear()
        await deps.stateStore.drop(deps.workspaceId)
      },
    ])
  }
  if (deps.ownsStateStore) await settle([() => deps.stateStore.close()])
  await settle([() => deps.cache.clear()])
  await settle([() => deps.cache.close()])
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'workspace teardown failed')
}
