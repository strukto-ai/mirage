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

import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Session, Workspace } from '@struktoai/mirage-core'
import { loadOptionalPeer } from '../optional_peer.ts'
import { MountBackend } from '@struktoai/mirage-core'
import { checkMountpoint, FSKIT_MOUNT_ROOT, prepareBackend } from './backend.ts'
import { MirageFS } from './fs.ts'

export interface FuseHandle {
  mountpoint: string
  /** Whether Mirage created this mountpoint directory and may remove it later. */
  ownsMountpoint: boolean
  unmount: () => Promise<void>
}

export interface MountOptions {
  /** Caller/deployment-owned mountpoint. Mirage mounts here but does not delete it. */
  mountpoint?: string
  /** Scope the mount to a single workspace mount prefix (subtree exposure). */
  rootPrefix?: string
  /** Run every op under this session's mount grants (session-bound mountpoint). */
  session?: Session
  /**
   * When true, `@zkochan/fuse-native`'s `autoUnmount` flag is set so the
   * kernel releases the mount if the process exits abnormally. Defaults to
   * `true` on Linux, `false` on darwin — macFUSE rejects the option with
   * "unknown option `auto_unmount'". On darwin the SIGINT cleanup in
   * FuseManager runs `diskutil unmount force` instead.
   */
  autoUnmount?: boolean
  /**
   * Extra options forwarded verbatim to `@zkochan/fuse-native`.
   * `directIO: false` additionally skips the `direct_io` mount option that
   * Mirage appends by default (see appendDirectIO).
   */
  fuseOptions?: Record<string, unknown>
  /**
   * Which kernel interface serves the mount: 'fuse' (default) or 'fskit'.
   * 'fskit' routes through macFUSE 5.x's FSKit backend (no kernel
   * extension); macOS-only, mounts under /Volumes, and every mounted
   * resource must report exact sizes. See backend.ts for the guards.
   */
  backend?: MountBackend
}

interface FuseInstance {
  mount: (cb: (err: Error | null) => void) => void
  unmount: (cb: (err: Error | null) => void) => void
  _fuseOptions?: () => string
}

type FuseConstructor = new (
  mountpoint: string,
  ops: Record<string, unknown>,
  options?: Record<string, unknown>,
) => FuseInstance

/**
 * Append raw libfuse options to the mount option string.
 * `@zkochan/fuse-native` serializes a fixed allowlist of options in
 * `_fuseOptions()`, so anything outside it (`direct_io`, `backend`,
 * `volname`) is appended by wrapping the serializer at runtime — this
 * ships to consumers, unlike a pnpm patch, which would only apply inside
 * this repository.
 */
export function appendMountOptions(fuse: FuseInstance, extras: string[]): void {
  const orig = fuse._fuseOptions?.bind(fuse)
  if (orig === undefined) {
    throw new Error(
      '@zkochan/fuse-native no longer exposes _fuseOptions(); extra mount ' +
        'options cannot be applied. Update appendMountOptions in mount.ts ' +
        'for the new fuse-native version.',
    )
  }
  fuse._fuseOptions = () => {
    const serialized = orig()
    const missing = extras.filter((opt) => !serialized.includes(opt))
    if (missing.length === 0) return serialized
    if (serialized === '') return `-o${missing.join(',')}`
    return `${serialized},${missing.join(',')}`
  }
}

/**
 * Append libfuse's `direct_io`. Load-bearing for size-unknown API files:
 * getattr reports 0 pre-open and the kernel must read to EOF regardless
 * (verified on the macOS kext: without it, `cat` reads 0 bytes; see the
 * CLAUDE.md FUSE section).
 */
export function appendDirectIO(fuse: FuseInstance): void {
  appendMountOptions(fuse, ['direct_io'])
}

async function loadFuse(): Promise<FuseConstructor> {
  const mod = await loadOptionalPeer(
    () => import('@zkochan/fuse-native') as unknown as Promise<{ default?: FuseConstructor }>,
    {
      feature: 'FUSE support',
      packageName: '@zkochan/fuse-native',
      docsUrl: 'https://mirage.dev/typescript/setup/fuse',
    },
  )
  const Fuse = (mod.default ?? mod) as unknown as FuseConstructor
  if (typeof Fuse !== 'function') {
    throw new Error('@zkochan/fuse-native did not export a constructor')
  }
  return Fuse
}

/** Fallback unmount via platform tools — mirrors Python's SIGINT handler. */
export function forceUnmount(mountpoint: string): void {
  try {
    if (process.platform === 'darwin') {
      execSync(`diskutil unmount force ${JSON.stringify(mountpoint)}`, { stdio: 'ignore' })
    } else {
      execSync(`fusermount -u ${JSON.stringify(mountpoint)}`, { stdio: 'ignore' })
    }
  } catch {
    // best-effort; caller already tried the clean path
  }
}

export async function mount(ws: Workspace, options: MountOptions = {}): Promise<FuseHandle> {
  const backend = prepareBackend(
    options.backend ?? MountBackend.FUSE,
    ws,
    undefined,
    options.rootPrefix ?? '',
  )
  const Fuse = await loadFuse()
  const isFskit = backend === MountBackend.FSKIT
  let mountpoint: string
  let ownsMountpoint = false
  if (options.mountpoint !== undefined) {
    checkMountpoint(backend, options.mountpoint)
    // Pinned path: create if missing, but keep ownership with the caller.
    // An FSKit mountpoint is NAMED, never created: /Volumes is root-owned
    // (mkdir there is EACCES for a normal user), and the volume directory
    // is the system's to create when the filesystem goes live.
    if (!isFskit) mkdirSync(options.mountpoint, { recursive: true })
    mountpoint = options.mountpoint
  } else if (isFskit) {
    mountpoint = `${FSKIT_MOUNT_ROOT}/mirage-${randomBytes(4).toString('hex')}`
    // The /Volumes entry is created and removed by the system, not ours to
    // rmdir (nor could we: /Volumes is root-owned).
  } else {
    mountpoint = mkdtempSync(join(tmpdir(), 'mirage-fuse-'))
    ownsMountpoint = true
  }
  const mfs = new MirageFS(ws, {
    ...(options.rootPrefix !== undefined ? { rootPrefix: options.rootPrefix } : {}),
    ...(options.session !== undefined ? { session: options.session } : {}),
  })
  const autoUnmount = options.autoUnmount ?? process.platform === 'linux'
  // Size-unknown recipe, mirroring Python's mount.py: direct_io (appended
  // below) makes the kernel read to EOF even though getattr reports 0
  // pre-open, and attrTimeout '0' (string: the option serializer drops falsy
  // values) keeps the kernel from caching that 0, so the post-open fstat
  // reaches fgetattr, which answers with the prefetched real size. Both are
  // load-bearing on the macOS kext; see the CLAUDE.md FUSE section.
  const fuseOpts: Record<string, unknown> = {
    force: true,
    mkdir: true,
    attrTimeout: '0',
    ...(autoUnmount ? { autoUnmount: true } : {}),
    ...(options.fuseOptions ?? {}),
  }
  const fuse = new Fuse(mountpoint, mfs.ops(), fuseOpts)
  if (isFskit) {
    // Issue #82's verified recipe: backend=fskit + volname, direct_io
    // omitted (FSKit has no direct_io; reads are driven by reported size,
    // which checkSizes guarantees is exact). Mirrors Python's _run_fuse.
    appendMountOptions(fuse, ['backend=fskit', `volname=${basename(mountpoint)}`])
  } else if (fuseOpts.directIO !== false) {
    appendDirectIO(fuse)
  }
  await new Promise<void>((resolve, reject) => {
    fuse.mount((err) => {
      if (err === null) resolve()
      else reject(err)
    })
  })
  return {
    mountpoint,
    ownsMountpoint,
    unmount: () =>
      new Promise<void>((resolve, reject) => {
        fuse.unmount((err) => {
          if (err === null) resolve()
          else reject(err)
        })
      }),
  }
}

export function mountBackground(ws: Workspace, options: MountOptions = {}): Promise<FuseHandle> {
  return mount(ws, options)
}
