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
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, Workspace } from '@struktoai/mirage-core'
import { loadOptionalPeer } from '../optional_peer.ts'
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
 * Append libfuse's `direct_io` to the mount option string.
 * `@zkochan/fuse-native` serializes a fixed allowlist of options in
 * `_fuseOptions()` that doesn't include `direct_io`, so we wrap the
 * serializer at runtime — this ships to consumers, unlike a pnpm patch,
 * which would only apply inside this repository. direct_io is load-bearing
 * for size-unknown API files: getattr reports 0 pre-open and the kernel
 * must read to EOF regardless (verified on the macOS kext: without it,
 * `cat` reads 0 bytes; see the CLAUDE.md FUSE section).
 */
export function appendDirectIO(fuse: FuseInstance): void {
  const orig = fuse._fuseOptions?.bind(fuse)
  if (orig === undefined) {
    throw new Error(
      '@zkochan/fuse-native no longer exposes _fuseOptions(); the direct_io ' +
        'mount option cannot be applied. Update appendDirectIO in mount.ts ' +
        'for the new fuse-native version.',
    )
  }
  fuse._fuseOptions = () => {
    const serialized = orig()
    if (serialized === '') return '-odirect_io'
    return serialized.includes('direct_io') ? serialized : `${serialized},direct_io`
  }
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
  const Fuse = await loadFuse()
  let mountpoint: string
  let ownsMountpoint = false
  if (options.mountpoint !== undefined) {
    // Pinned path: create if missing, but keep ownership with the caller.
    mkdirSync(options.mountpoint, { recursive: true })
    mountpoint = options.mountpoint
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
  if (fuseOpts.directIO !== false) appendDirectIO(fuse)
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
