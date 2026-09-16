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
import { describe, expect, it } from 'vitest'
import { KernelRoute, requireKernelBackend, resolveBackend, routeOf } from './backend.ts'

describe('kernel routes', () => {
  it('declares a route for every backend', () => {
    // The point of the table: a backend added to the enum has to say
    // how it is mounted, rather than falling into whatever branch came
    // last. The Record type pins this at compile time too.
    for (const backend of Object.values(MountBackend)) {
      expect(Object.values(KernelRoute)).toContain(routeOf(backend))
    }
  })

  it('routes exactly the kernel backends', () => {
    const routed = Object.values(MountBackend).filter((b) => routeOf(b) !== KernelRoute.NONE)

    expect(routed.sort()).toEqual([...KERNEL_BACKENDS].sort())
  })

  it('gives fuse and fskit the route a synchronous constructor can mount', () => {
    expect(routeOf(MountBackend.FUSE)).toBe(KernelRoute.THREAD)
    expect(routeOf(MountBackend.FSKIT)).toBe(KernelRoute.THREAD)
  })

  it("serves nfs from the caller's loop", () => {
    // Mounting one from a synchronous call deadlocks the loop that has
    // to answer the kernel's first request.
    expect(routeOf(MountBackend.NFS)).toBe(KernelRoute.LOOP)
  })

  it('never routes vfs to the kernel', () => {
    expect(routeOf(MountBackend.VFS)).toBe(KernelRoute.NONE)
  })
})

describe('backend names', () => {
  it('reads a missing value as vfs', () => {
    expect(resolveBackend()).toBe(MountBackend.VFS)
    expect(resolveBackend(null)).toBe(MountBackend.VFS)
    expect(resolveBackend('')).toBe(MountBackend.VFS)
  })

  it('names the known ones when it refuses', () => {
    expect(() => resolveBackend('smb')).toThrow(/unknown mount backend/)
  })

  it('refuses vfs where a mountpoint is required', () => {
    expect(() => {
      requireKernelBackend(MountBackend.VFS)
    }).toThrow(/does not register a mountpoint/)
  })
})
