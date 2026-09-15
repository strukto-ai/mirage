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
import { KERNEL_BACKENDS, MountBackend } from '@struktoai/mirage-core/types'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { sizesAlwaysKnown } from '@struktoai/mirage-core/resource/base'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'

/**
 * Coerce a user-supplied backend name into a MountBackend.
 *
 * Missing means vfs, everywhere: an absent `backend` in YAML, `undefined`
 * here, and the `MountSpecOptions` default all resolve to the same thing.
 * Callers that need a kernel mount say so explicitly rather than relying on
 * this function to reinterpret an absent value.
 */
export function resolveBackend(value?: string | null): MountBackend {
  if (value === undefined || value === null || value === '') return MountBackend.VFS
  const lowered = value.toLowerCase() as MountBackend
  if (!Object.values(MountBackend).includes(lowered)) {
    throw new Error(
      `unknown mount backend ${JSON.stringify(value)}; expected one of: ${Object.values(
        MountBackend,
      ).join(', ')}`,
    )
  }
  return lowered
}

/**
 * How a backend's mount is brought up, and by whom.
 *
 * The distinction is not cosmetic: it decides which call can mount a
 * prefix at all. A `thread` backend hands the kernel a file descriptor
 * and services it from a daemon thread, so it comes up inside a
 * synchronous constructor. A `loop` backend is served by the caller's
 * own event loop, so mounting one from a synchronous call would deadlock
 * the loop that has to answer the kernel's first request. `none` never
 * reaches the kernel at all.
 */
export const KernelRoute = Object.freeze({
  NONE: 'none',
  THREAD: 'thread',
  LOOP: 'loop',
} as const)

export type KernelRoute = (typeof KernelRoute)[keyof typeof KernelRoute]

// One row per MountBackend member. `Record` makes it exhaustive at
// compile time: a backend added to the enum fails to typecheck until it
// declares how it is mounted, rather than falling into whatever the last
// else branch happened to be -- which is how a loop-served mount would
// end up being started from a constructor.
const ROUTES: Record<MountBackend, KernelRoute> = {
  [MountBackend.VFS]: KernelRoute.NONE,
  [MountBackend.FUSE]: KernelRoute.THREAD,
  [MountBackend.FSKIT]: KernelRoute.THREAD,
  [MountBackend.NFS]: KernelRoute.LOOP,
}

/** How this backend's mount has to be brought up. */
export function routeOf(backend: MountBackend): KernelRoute {
  const route = ROUTES[backend] as KernelRoute | undefined
  if (route === undefined) {
    throw new Error(
      `backend ${JSON.stringify(backend)} declares no kernel route; add one to ` +
        'mount/backend.ts rather than letting it default',
    )
  }
  return route
}

/** Reject a backend that registers nothing with the kernel. */
export function requireKernelBackend(backend: MountBackend): void {
  if (!KERNEL_BACKENDS.includes(backend)) {
    throw new Error(
      `backend ${JSON.stringify(backend)} does not register a mountpoint; it is served inside ` +
        "mirage's own filesystem, so there is nothing to mount",
    )
  }
}

/**
 * Mounts under `rootPrefix` whose files cannot be sized without reading
 * them. Mirrors Python's `Ops.unsized_mounts`.
 */
export function unsizedMounts(ws: Workspace, rootPrefix = ''): [string, string][] {
  const root = rstripSlash(rootPrefix)
  const found: [string, string][] = []
  for (const m of ws.mounts()) {
    const bare = rstripSlash(m.prefix)
    if (root !== '' && bare !== root && !m.prefix.startsWith(root + '/')) continue
    if (!sizesAlwaysKnown(m.resource)) found.push([m.prefix, m.resource.kind])
  }
  return found
}
