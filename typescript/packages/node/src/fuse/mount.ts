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

import { execFile, execFileSync, execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { MountBackend } from '@struktoai/mirage-core/types'
import type { SessionState } from '@struktoai/mirage-core/workspace/session/session'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { loadOptionalPeer } from '../optional_peer.ts'
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
  session?: SessionState
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
   * VFS must report exact sizes. See backend.ts for the guards.
   */
  backend?: MountBackend
}

interface FuseInstance {
  mount: (cb: (err: Error | null) => void) => void
  unmount: (cb: (err: Error | null) => void) => void
  _fuseOptions?: () => string
}

type FuseConstructor = (new (
  mountpoint: string,
  ops: Record<string, unknown>,
  options?: Record<string, unknown>,
) => FuseInstance) & {
  unmount: (mountpoint: string, cb: (err: Error | null) => void) => void
}

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

/**
 * What to install when the binding will not load, for the platform it did
 * not load on. Only macOS and Linux have an answer: fuse-native's legacy
 * Windows path builds against the unmaintained Dokany-based
 * `fuse-shared-library-win32` rather than WinFsp, so naming a Windows
 * driver would send the reader after something that cannot fix it. Python
 * is the one that mounts FUSE on Windows.
 */
export function driverHint(platform: string = process.platform): string {
  if (platform === 'darwin') return 'FUSE also needs the macFUSE driver, installed separately.'
  if (platform === 'linux') return 'FUSE also needs libfuse3, from the fuse3 package.'
  return (
    'TypeScript FUSE mounts run on macOS and Linux only: @zkochan/fuse-native ' +
    'does not support WinFsp. Python mounts FUSE on Windows experimentally.'
  )
}

async function loadFuse(): Promise<FuseConstructor> {
  const mod = await loadOptionalPeer(
    () => import('@zkochan/fuse-native') as unknown as Promise<{ default?: FuseConstructor }>,
    {
      feature: 'FUSE support',
      packageName: '@zkochan/fuse-native',
      docsUrl: 'https://mirage.dev/typescript/setup/fuse',
      // fuse-native dlopens its binding against libfuse as it loads, so a
      // machine with the package and no driver fails here, not at
      // resolution (ERR_DLOPEN_FAILED, or no prebuild for the platform).
      systemHint: driverHint(),
    },
  )
  const Fuse = (mod.default ?? mod) as unknown as FuseConstructor
  if (typeof Fuse !== 'function') {
    throw new Error('@zkochan/fuse-native did not export a constructor')
  }
  if (process.platform === 'linux') Fuse.unmount = unmountWithFusermount
  return Fuse
}

/**
 * Locate the platform FUSE unmount helper (mirrors Python's resolve_fusermount_binary).
 * The fuse3 package ships only `fusermount3` on Fedora, RHEL, Amazon Linux 2023,
 * openSUSE and Alpine. Debian and Ubuntu add a `fusermount` symlink, so CI on
 * Ubuntu never exercises the fallback.
 */
export function resolveFusermountBinary(): string | null {
  const pathEnv = process.env.PATH ?? ''
  for (const name of ['fusermount', 'fusermount3']) {
    for (const dir of pathEnv.split(delimiter)) {
      const candidate = join(dir, name)
      try {
        if (statSync(candidate).isFile()) {
          accessSync(candidate, fsConstants.X_OK)
          return candidate
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === undefined) throw err
      }
    }
  }
  return null
}

/**
 * The path the kernel's mount table records for `mountpoint` (mirrors
 * Python's canonical_mountpoint). Resolve it at mount time: a parent or
 * symlink removed later no longer resolves to where the mount sits.
 */
export function canonicalMountpoint(mountpoint: string): string {
  const path = resolve(mountpoint)
  return join(realpathSync(dirname(path)), basename(path))
}

/**
 * Whether the kernel's mount table lists `mountpoint` (mirrors Python's
 * is_mounted). Reads /proc/self/mounts rather than stat'ing the path, which
 * would call into the very FUSE server being released. The path is compared
 * as given: pass the one canonicalMountpoint returned at mount time.
 */
export function isMounted(mountpoint: string): boolean {
  return readFileSync('/proc/self/mounts', 'utf8')
    .split('\n')
    .some(
      (line) =>
        (line.split(' ')[1] ?? '').replace(/\\([0-7]{3})/g, (_match, octal: string) =>
          String.fromCharCode(parseInt(octal, 8)),
        ) === mountpoint,
    )
}

/**
 * Release a Linux FUSE mount with fusermount or fusermount3 (mirrors Python's
 * unmount_with_fusermount). Installed as fuse-native's static unmount, which
 * shells out to a hardcoded `fusermount -uz` and, on any error, skips the
 * native cleanup that lets node exit. A mount already released from outside
 * counts as unmounted, and `cb` runs exactly once whatever fails.
 */
export function unmountWithFusermount(mountpoint: string, cb: (err: Error | null) => void): void {
  const settle = (err: Error | null): void => {
    let failure = err
    if (err !== null) {
      try {
        if (!isMounted(mountpoint)) failure = null
      } catch (checkErr) {
        failure = checkErr as Error
      }
    }
    cb(failure)
  }
  const binary = resolveFusermountBinary()
  if (binary === null) {
    settle(
      new Error(`cannot unmount ${mountpoint}: neither 'fusermount' nor 'fusermount3' is on PATH`),
    )
    return
  }
  execFile(binary, ['-uz', mountpoint], (err, _stdout, stderr) => {
    settle(
      err === null
        ? null
        : new Error(`cannot unmount ${mountpoint}: ${stderr.trim()}`, { cause: err }),
    )
  })
}

/** Fallback unmount via platform tools — mirrors Python's SIGINT handler. */
export function forceUnmount(mountpoint: string): void {
  try {
    if (process.platform === 'darwin') {
      execSync(`diskutil unmount force ${JSON.stringify(mountpoint)}`, { stdio: 'ignore' })
    } else {
      const binary = resolveFusermountBinary()
      if (binary !== null) {
        execFileSync(binary, ['-u', mountpoint], { stdio: 'ignore' })
      }
    }
  } catch (err) {
    // Best effort: the caller already tried the clean path.
    console.debug(`fuse: force unmount of ${mountpoint} failed: ${String(err)}`)
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
  const mfs = new MirageFS(ws.vfs, {
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
  // fuse-native hands this path to unmountWithFusermount, which looks it up
  // in the mount table, so Linux mounts at the path resolved now, while
  // every parent still exists.
  const fuse = new Fuse(
    process.platform === 'linux' ? canonicalMountpoint(mountpoint) : mountpoint,
    mfs.ops(),
    fuseOpts,
  )
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
