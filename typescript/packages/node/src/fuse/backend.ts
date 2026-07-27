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
import { sizesAlwaysKnown, type Workspace } from '@struktoai/mirage-core'

/**
 * FSKit mounts only under /Volumes. Anywhere else the mount fails with an
 * opaque driver error, so the rule is enforced up front rather than
 * discovered at run time (github.com/strukto-ai/mirage#82).
 */
export const FSKIT_MOUNT_ROOT = '/Volumes'

/**
 * Which kernel interface serves a mount.
 *
 * `fuse` is the default everywhere and the only backend on Linux and
 * Windows. `fskit` routes through macFUSE 5.x's FSKit shim, which needs no
 * kernel extension but has no `direct_io` equivalent, so it can only serve
 * resources whose files always have a known size.
 *
 * There is deliberately no `auto`: auto-selecting fskit would silently
 * break every API-backed mount, and an option whose safe value is always
 * the default is a trap.
 */
export const MountBackend = {
  FUSE: 'fuse',
  FSKIT: 'fskit',
} as const

export type MountBackend = (typeof MountBackend)[keyof typeof MountBackend]

const BACKENDS: string[] = Object.values(MountBackend)

/** Coerce a user-supplied backend name; undefined and '' mean the default. */
export function resolveBackend(value?: string | null): MountBackend {
  if (value === undefined || value === null || value === '') return MountBackend.FUSE
  const lowered = value.toLowerCase()
  if (!BACKENDS.includes(lowered)) {
    throw new Error(
      `unknown mount backend ${JSON.stringify(value)}; expected one of: ${BACKENDS.join(', ')}`,
    )
  }
  return lowered as MountBackend
}

/**
 * Reject a backend this runtime cannot serve.
 *
 * Known gap, deliberate: TypeScript cannot reach FSKit at all.
 * `@zkochan/fuse-native` bundles its own pre-macFUSE-5 dylib, so the
 * `backend=fskit` mount option never reaches a driver that understands it.
 * Python (mfusepy, which links the installed libfuse) is the only side that
 * can. Documented in docs/typescript/setup/fuse.mdx alongside the ORC gap.
 */
export function checkPlatform(backend: MountBackend): void {
  if (backend !== MountBackend.FSKIT) return
  if (process.platform !== 'darwin') {
    throw new Error(
      `the fskit mount backend is macOS-only (running on ${process.platform}); use backend 'fuse'`,
    )
  }
  throw new Error(
    "the fskit mount backend is not available in TypeScript: '@zkochan/fuse-native' bundles a " +
      'pre-macFUSE-5 dylib that cannot route to FSKit. Use the Python package for kext-free ' +
      'mounts, or backend "fuse" here. See https://mirage.dev/typescript/setup/fuse',
  )
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
  const root = rootPrefix.replace(/\/+$/, '')
  const found: [string, string][] = []
  for (const m of ws.mounts()) {
    const bare = m.prefix.replace(/\/+$/, '')
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
