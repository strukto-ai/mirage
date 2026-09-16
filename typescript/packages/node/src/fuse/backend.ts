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

import { posix } from 'node:path'
import { MountBackend, MountMode } from '@struktoai/mirage-core/types'
import { requireKernelBackend, resolveBackend, unsizedMounts } from '../mount/backend.ts'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'

/**
 * FSKit mounts only under /Volumes. Anywhere else the mount fails with an
 * opaque driver error, so the rule is enforced up front rather than
 * discovered at run time (github.com/strukto-ai/mirage#82).
 */
export const FSKIT_MOUNT_ROOT = '/Volumes'

/**
 * Reject a backend the current platform cannot serve.
 *
 * FSKit works from TypeScript: `fuse.node` links `/usr/local/lib/
 * libfuse.2.dylib` by absolute path (the `libosxfuse.2.dylib` it ships is a
 * stub with that install name), so on a machine with macFUSE 5.x the
 * `backend=fskit` option reaches the same libfuse Python uses. Verified
 * with a live mount; see examples/typescript/fuse/fskit.ts.
 */
export function checkPlatform(backend: MountBackend): void {
  if (backend !== MountBackend.FSKIT) return
  if (process.platform !== 'darwin') {
    throw new Error(
      `the fskit mount backend is macOS-only (running on ${process.platform}); use backend 'fuse'`,
    )
  }
}

/** Reject a mountpoint the backend cannot mount on. */
export function checkMountpoint(backend: MountBackend, mountpoint: string): void {
  if (backend !== MountBackend.FSKIT) return
  const resolved = posix.normalize(mountpoint)
  if (resolved !== FSKIT_MOUNT_ROOT && !resolved.startsWith(FSKIT_MOUNT_ROOT + '/')) {
    throw new Error(
      `the fskit mount backend only mounts under ${FSKIT_MOUNT_ROOT}; got ${JSON.stringify(mountpoint)}`,
    )
  }
}

/**
 * Warn when an fskit mount will serve size-unknown files as empty.
 *
 * FSKit drives reads from the size the filesystem reports and has no
 * `direct_io` escape hatch, so a resource that cannot size a file without
 * fetching it reports 0, the kernel issues no reads, and every such file
 * comes back empty with exit code 0 (verified on a live fskit mount: the
 * read clamp is pinned at lookup-time size and never refreshed). The mount
 * proceeds anyway: per-backend size push-down is closing this gap, so the
 * degraded mounts are named loudly here rather than refused.
 */
export function checkSizes(backend: MountBackend, ws: Workspace, rootPrefix = ''): void {
  if (backend !== MountBackend.FSKIT) return
  const offenders = unsizedMounts(ws, rootPrefix)
  if (offenders.length === 0) return
  const listed = offenders.map(([prefix, kind]) => `${prefix} (${kind})`).join(', ')
  console.warn(
    'mirage: the fskit mount backend cannot serve resources whose file sizes are only known ' +
      `after a read; size-unknown files under these mounts will read as empty: ${listed}. ` +
      "Mount them with backend 'fuse', or scope the fskit mount to a byte-store resource " +
      '(ram, disk, redis, s3, gridfs).',
  )
}

/**
 * Mounts that accept writes, in mount resolution order. Mirrors Python's
 * `Ops.writable_mounts`.
 */
export function writableMounts(ws: Workspace, rootPrefix = ''): [string, string][] {
  const root = rstripSlash(rootPrefix)
  const found: [string, string][] = []
  for (const m of ws.mounts()) {
    const bare = rstripSlash(m.prefix)
    if (root !== '' && bare !== root && !m.prefix.startsWith(root + '/')) continue
    if (m.mode !== MountMode.READ) found.push([m.prefix, m.resource.kind])
  }
  return found
}

/**
 * Warn when an fskit mount accepts writes the shim may corrupt.
 *
 * Measured on live fskit mounts and pinned in `integ/fuse/truth_fskit.json`: the
 * macFUSE FSKit shim flushes pages a file did not already have (a new file,
 * an empty file, a truncate-then-write) as NUL bytes of the right length,
 * and appended regions arrive intact or zeroed depending on cache state.
 * Metadata ops (create, mkdir, rename, unlink) are reliable. The writer sees
 * no error either way, so the corruption is silent; the mount proceeds with
 * a warning naming the writable mounts.
 */
export function checkWrites(backend: MountBackend, ws: Workspace, rootPrefix = ''): void {
  if (backend !== MountBackend.FSKIT) return
  // /dev is mounted writable into every workspace, and a zeroed flush
  // cannot corrupt a discard/byte-source device, so it never warns.
  const offenders = writableMounts(ws, rootPrefix).filter(
    ([prefix]) => rstripSlash(prefix) !== '/dev',
  )
  if (offenders.length === 0) return
  const listed = offenders.map(([prefix, kind]) => `${prefix} (${kind})`).join(', ')
  console.warn(
    'mirage: file data written through an fskit mount may be flushed by the macFUSE FSKit ' +
      `shim as zeroed pages (metadata ops are reliable; the writer sees no error): ${listed}. ` +
      "Mount them read-only, or use backend 'fuse' for writes.",
  )
}

/**
 * Resolve a backend for a kernel mount and run every guard it implies.
 *
 * One entry point, so a new mount path cannot pick up fskit support while
 * silently skipping the macOS, /Volumes, or size checks.
 */
export function prepareBackend(
  value: string | undefined,
  ws?: Workspace,
  mountpoint?: string,
  rootPrefix = '',
): MountBackend {
  const backend = resolveBackend(value)
  requireKernelBackend(backend)
  checkPlatform(backend)
  if (mountpoint !== undefined) checkMountpoint(backend, mountpoint)
  if (ws !== undefined) {
    checkSizes(backend, ws, rootPrefix)
    checkWrites(backend, ws, rootPrefix)
  }
  return backend
}
