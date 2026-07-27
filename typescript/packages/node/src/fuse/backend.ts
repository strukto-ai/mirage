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
import {
  KERNEL_BACKENDS,
  MountBackend,
  rstripSlash,
  sizesAlwaysKnown,
  type Workspace,
} from '@struktoai/mirage-core'

/**
 * FSKit mounts only under /Volumes. Anywhere else the mount fails with an
 * opaque driver error, so the rule is enforced up front rather than
 * discovered at run time (github.com/strukto-ai/mirage#82).
 */
export const FSKIT_MOUNT_ROOT = '/Volumes'

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

/**
 * Refuse an fskit mount that would serve silently empty files.
 *
 * FSKit drives reads from the size the filesystem reports and has no
 * `direct_io` escape hatch, so a resource that cannot size a file without
 * fetching it reports 0, the kernel issues no reads, and every such file
 * comes back empty with exit code 0. That is worse than a failed mount, so
 * it fails here by name instead.
 */
export function checkSizes(backend: MountBackend, ws: Workspace, rootPrefix = ''): void {
  if (backend !== MountBackend.FSKIT) return
  const offenders = unsizedMounts(ws, rootPrefix)
  if (offenders.length === 0) return
  const listed = offenders.map(([prefix, kind]) => `${prefix} (${kind})`).join(', ')
  throw new Error(
    'the fskit mount backend cannot serve resources whose file sizes are only known after a ' +
      `read; these mounts would return empty files: ${listed}. Mount them with backend 'fuse', ` +
      'or scope the fskit mount to a byte-store resource (ram, disk, redis, s3, gridfs).',
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
  if (ws !== undefined) checkSizes(backend, ws, rootPrefix)
  return backend
}
