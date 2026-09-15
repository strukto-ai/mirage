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

import { createServer } from 'node:net'

import { MountBackend } from '@struktoai/mirage-core/types'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'

import { requireKernelBackend, resolveBackend, unsizedMounts } from '../mount/backend.ts'
import type { NFSConfig } from './config.ts'

/**
 * Platforms whose mount command needs elevated privileges. macOS mounts a
 * loopback NFS export as the invoking user; Linux reserves mount(2) for root
 * unless an fstab entry says otherwise.
 */
export const PRIVILEGED_PLATFORMS = ['linux', 'win32'] as const

/** Whether mounting needs elevated privileges on this platform. */
export function requiresPrivilege(platform: string = process.platform): boolean {
  return PRIVILEGED_PLATFORMS.some((tag) => platform.startsWith(tag))
}

/**
 * Refuse a platform whose mount command this backend cannot build.
 *
 * macOS and Linux both ship a kernel NFS client and a mount command the argv
 * builder knows. Windows does not qualify yet: the client is Pro-only,
 * `mount.exe` speaks a different grammar, and none of it has been exercised —
 * refusing loudly beats emitting a Linux-shaped command that cannot work, the
 * same advisory stance the repo takes on FUSE-over-WinFsp.
 */
export function checkPlatformNfs(platform: string = process.platform): void {
  if (platform.startsWith('win')) {
    throw new Error(
      'the nfs mount backend does not support Windows yet; use backend ' + "'fuse' with WinFsp",
    )
  }
}

/**
 * Resolve and validate a backend for an NFS mount.
 *
 * One entry point, mirroring `fuse/backend.ts`'s `prepareBackend`, so a new
 * mount path cannot pick up NFS while skipping its guards.
 */
export function prepareNfsBackend(value?: string | null): MountBackend {
  const backend = resolveBackend(value)
  requireKernelBackend(backend)
  if (backend !== MountBackend.NFS) {
    throw new Error(`the nfs mount path serves backend 'nfs'; got ${JSON.stringify(backend)}`)
  }
  return backend
}

/**
 * Fail before starting a server on a port already in use.
 *
 * Probed before the server so a collision surfaces here, naming the port,
 * rather than as an opaque bind failure from inside the addon. Port 0 always
 * passes: it asks the OS to choose.
 */
export async function checkPortAvailable(host: string, port: number): Promise<void> {
  if (port === 0) return
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', (err: Error) => {
      probe.close()
      reject(new Error(`nfs port ${String(port)} on ${host} is already in use: ${err.message}`))
    })
    probe.listen({ host, port }, () => {
      probe.close(() => {
        resolve()
      })
    })
  })
}

/**
 * Warn when a mount will serve size-unknown files as empty.
 *
 * NFSv3 has no OPEN procedure, so the hydrate-on-open trick the FUSE adapter
 * uses never fires, and the client stops reading at the size GETATTR
 * reported. A resource that cannot size a file without fetching it therefore
 * reports 0 and the file reads as empty. The mount proceeds: the degraded
 * mounts are named loudly here rather than refused, matching what the fskit
 * backend does with the same limitation.
 */
export function checkSizesNfs(ws: Workspace, rootPrefix = ''): void {
  const offenders = unsizedMounts(ws, rootPrefix)
  if (offenders.length === 0) return
  const listed = offenders.map(([prefix, kind]) => `${prefix} (${kind})`).join(', ')
  console.warn(
    'mirage: the nfs mount backend cannot serve resources whose file sizes are only known ' +
      `after a read; size-unknown files under these mounts will read as empty: ${listed}. ` +
      "Mount them with backend 'fuse', or scope the nfs mount to a byte-store resource " +
      '(ram, disk, redis, s3, gridfs).',
  )
}

/** Run every guard an NFS mount implies, in order. */
export async function prepareNfsMount(
  value: string | null | undefined,
  ws: Workspace,
  config: NFSConfig,
  rootPrefix = '',
): Promise<MountBackend> {
  const backend = prepareNfsBackend(value)
  checkPlatformNfs()
  await checkPortAvailable(config.host, config.port)
  checkSizesNfs(ws, rootPrefix)
  if (requiresPrivilege()) {
    // Nothing here elevates: the argv is a bare mount command, so the
    // process has to hold the privilege already (or the mountpoint needs
    // an fstab entry). Python's twin says the same thing; it used to
    // promise sudo, which no code in either language has ever run.
    console.warn(
      `mirage: mounting an nfs export on ${process.platform} needs elevated privileges; run ` +
        'the process with them, or give the mountpoint an fstab entry, or the mount command ' +
        'will fail',
    )
  }
  return backend
}
