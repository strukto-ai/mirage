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

import { execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'

import type { Session } from '@struktoai/mirage-core/workspace/session/session'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'

import { prepareNfsMount } from './backend.ts'
import { NFSConfig } from './config.ts'
import { nfsErrno } from './errors.ts'
import { bindSession, scopedFlush } from './session.ts'
import type { NFSFlushable } from './session.ts'
import { MirageNFS } from './delegate.ts'
import type { DirEntry, NFSAttrs } from './types.ts'

const run = promisify(execFile)

export const MOUNT_TIMEOUT_SECONDS = 10
export const UMOUNT_TIMEOUT_SECONDS = 15
export const UMOUNT_RETRY_PAUSE = 0.5
export const PROBE_TIMEOUT_SECONDS = 2
const POLL_SECONDS = 0.05

/** The npm package carrying the prebuilt addon (`mirage-nfs-node`). */
export const ADDON_PACKAGE = '@struktoai/mirage-nfs-node'
/** Points the loader at a locally built `.node`, for development and integ. */
export const ADDON_ENV = 'MIRAGE_NFS_ADDON'

const requireAddon = createRequire(import.meta.url)

// ── The addon's wire shapes ──────────────────────────────────────────
// One interface per `#[napi(object)]` in `mirage-nfs/src/bridge.rs`, in
// its field order. A reply carries `errno` instead of throwing, because
// an exception cannot cross into rust: the addon reads the number and
// maps it onto an nfsstat3.

export interface NameArgs {
  dirId: number
  name: string
}

export interface IdArgs {
  id: number
}

export interface ReadArgs {
  id: number
  offset: number
  count: number
}

export interface WriteArgs {
  id: number
  offset: number
  data: Buffer
}

export interface SetSizeArgs {
  id: number
  size?: number | null
}

export interface RenameArgs {
  fromDirId: number
  fromName: string
  toDirId: number
  toName: string
}

export interface SymlinkArgs {
  dirId: number
  name: string
  target: string
}

export interface ReaddirArgs {
  dirId: number
  startAfter: number
  maxEntries: number
}

/**
 * `Attrs` from bridge.rs. Only `errno`, `mode` and `mtimeEpoch` are
 * `Option` there, so a failure reply still has to carry the other four
 * fields or the rust side cannot deserialize it at all and the client
 * sees SERVERFAULT in place of the real condition.
 */
export type AttrsReply = NFSAttrs & { errno?: number }

export interface IdReply {
  errno?: number
  fileid?: number
}

export interface BytesReply {
  errno?: number
  data?: Buffer
}

export interface TextReply {
  errno?: number
  text?: string
}

export interface UnitReply {
  errno?: number
}

export interface EntriesReply {
  errno?: number
  entries?: { name: string; attrs: AttrsReply }[]
}

/** The thirteen callbacks `start()` takes, in its argument order. */
export interface NFSDelegate {
  lookup: (args: NameArgs) => Promise<IdReply>
  getattr: (args: IdArgs) => Promise<AttrsReply>
  setSize: (args: SetSizeArgs) => Promise<AttrsReply>
  read: (args: ReadArgs) => Promise<BytesReply>
  write: (args: WriteArgs) => Promise<AttrsReply>
  create: (args: NameArgs) => Promise<IdReply>
  createExclusive: (args: NameArgs) => Promise<IdReply>
  mkdir: (args: NameArgs) => Promise<IdReply>
  remove: (args: NameArgs) => Promise<UnitReply>
  rename: (args: RenameArgs) => Promise<UnitReply>
  symlink: (args: SymlinkArgs) => Promise<IdReply>
  readlink: (args: IdArgs) => Promise<TextReply>
  readdir: (args: ReaddirArgs) => Promise<EntriesReply>
  flushIdle: (args: IdArgs) => Promise<UnitReply>
}

/** The adapter surface `buildDelegate` marshals; `MirageNFS` implements it. */
export interface NFSDelegateTarget {
  lookup: (dirid: number, name: string) => Promise<number>
  getattr: (fileid: number) => Promise<NFSAttrs>
  setSize: (fileid: number, size: number | null) => Promise<NFSAttrs>
  read: (fileid: number, offset: number, count: number) => Promise<Buffer>
  write: (fileid: number, offset: number, data: Buffer) => Promise<NFSAttrs>
  create: (dirid: number, name: string) => Promise<number>
  createExclusive: (dirid: number, name: string) => Promise<number>
  mkdir: (dirid: number, name: string) => Promise<number>
  remove: (dirid: number, name: string) => Promise<void>
  rename: (fromDirid: number, fromName: string, toDirid: number, toName: string) => Promise<void>
  symlink: (dirid: number, name: string, target: string) => Promise<number>
  readlink: (fileid: number) => Promise<string>
  readdir: (dirid: number, cookie: number, maxEntries: number) => Promise<DirEntry[]>
  flushIdle: () => Promise<void>
}

/** A running server. `NfsServerHandle` in `mirage-nfs/src/lib.rs`. */
export interface NFSServerHandle {
  port: () => number
  stop: () => void
}

export interface NFSAddon {
  start: (
    lookup: NFSDelegate['lookup'],
    getattr: NFSDelegate['getattr'],
    setSize: NFSDelegate['setSize'],
    read: NFSDelegate['read'],
    write: NFSDelegate['write'],
    create: NFSDelegate['create'],
    createExclusive: NFSDelegate['createExclusive'],
    mkdir: NFSDelegate['mkdir'],
    remove: NFSDelegate['remove'],
    rename: NFSDelegate['rename'],
    symlink: NFSDelegate['symlink'],
    readlink: NFSDelegate['readlink'],
    readdir: NFSDelegate['readdir'],
    flushIdle: NFSDelegate['flushIdle'],
    host: string,
    port: number,
    rootId: number,
    uid: number,
    gid: number,
    idleSeconds: number,
  ) => Promise<NFSServerHandle>
}

/**
 * Load the addon, naming the install when it is absent.
 *
 * The addon is optional the way FUSE's driver is: importing mirage never
 * requires it, and the error names what to install rather than leaking a
 * resolution failure from inside a mount call. It is loaded through
 * `createRequire` because a `.node` binding is CommonJS whichever name
 * reaches it, and because that is the only form the `ADDON_ENV` override
 * (an absolute path to a local build) can take.
 */
export function loadAddon(): NFSAddon {
  const override = process.env[ADDON_ENV]
  const specifier =
    override === undefined || override === '' ? ADDON_PACKAGE : resolvePath(override)
  try {
    const loaded: unknown = requireAddon(specifier)
    return loaded as NFSAddon
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `the nfs mount backend needs the ${ADDON_PACKAGE} addon; install it with: ` +
        `npm install ${ADDON_PACKAGE}, or point ${ADDON_ENV} at a local build ` +
        `(${reason})`,
    )
  }
}

/**
 * Wrap one adapter as the fourteen callbacks the addon calls back into.
 *
 * There is no python twin: PyO3 calls methods on the delegate object
 * itself, so its classification lives in rust. napi takes plain
 * functions, and no exception may cross the boundary, so each wrapper
 * catches and answers with an errno reply instead — the one place that
 * translation happens.
 */
export function buildDelegate(fs: NFSDelegateTarget, session?: Session | null): NFSDelegate {
  const table: NFSDelegate = {
    lookup: async ({ dirId, name }) => idReply(() => fs.lookup(dirId, name)),
    getattr: async ({ id }) => attrsReply(id, () => fs.getattr(id)),
    setSize: async ({ id, size }) => attrsReply(id, () => fs.setSize(id, size ?? null)),
    read: async ({ id, offset, count }) => {
      try {
        return { data: await fs.read(id, offset, count) }
      } catch (err) {
        return { errno: nfsErrno(err) }
      }
    },
    write: async ({ id, offset, data }) => attrsReply(id, () => fs.write(id, offset, data)),
    create: async ({ dirId, name }) => idReply(() => fs.create(dirId, name)),
    createExclusive: async ({ dirId, name }) => idReply(() => fs.createExclusive(dirId, name)),
    mkdir: async ({ dirId, name }) => idReply(() => fs.mkdir(dirId, name)),
    remove: async ({ dirId, name }) => unitReply(() => fs.remove(dirId, name)),
    rename: async ({ fromDirId, fromName, toDirId, toName }) =>
      unitReply(() => fs.rename(fromDirId, fromName, toDirId, toName)),
    symlink: async ({ dirId, name, target }) => idReply(() => fs.symlink(dirId, name, target)),
    readlink: async ({ id }) => {
      try {
        return { text: await fs.readlink(id) }
      } catch (err) {
        return { errno: nfsErrno(err) }
      }
    },
    readdir: async ({ dirId, startAfter, maxEntries }) => {
      try {
        const entries = await fs.readdir(dirId, startAfter, maxEntries)
        // DirEntryOut is { name, attrs }: vfs.rs reads the id off
        // attrs.fileid, so the cookie never travels as its own field.
        return { entries: entries.map(({ name, attrs }) => ({ name, attrs })) }
      } catch (err) {
        return { errno: nfsErrno(err) }
      }
    },
    flushIdle: async () => unitReply(() => fs.flushIdle()),
  }
  return session === undefined || session === null ? table : bindSession(table, session)
}

async function idReply(call: () => Promise<number>): Promise<IdReply> {
  try {
    return { fileid: await call() }
  } catch (err) {
    return { errno: nfsErrno(err) }
  }
}

async function unitReply(call: () => Promise<void>): Promise<UnitReply> {
  try {
    await call()
    return {}
  } catch (err) {
    return { errno: nfsErrno(err) }
  }
}

async function attrsReply(fileid: number, call: () => Promise<NFSAttrs>): Promise<AttrsReply> {
  try {
    return await call()
  } catch (err) {
    return { errno: nfsErrno(err), fileid, size: 0, isDir: false, isSymlink: false }
  }
}

/**
 * The `-o` string for one export.
 *
 * `port=mountport=<port>` keeps portmap (111) and NLM out of the picture
 * entirely; `actimeo=0` keeps client attribute caches fresh, the
 * analogue of the FUSE mounts' `attr_timeout=0`.
 *
 * The rest is the escape hatch, and it is the difference between a
 * stalled server costing an error and costing the host. A hard mount --
 * the platform default -- blocks every I/O on the mountpoint forever and
 * uninterruptibly when nothing answers, and since macOS walks the mount
 * table for Finder, df and Spotlight, one wedged mount takes the desktop
 * with it. `soft` + `timeo` + `retrans` bound the wait and fail the call
 * instead; `intr` makes even a hard mount killable; `deadtimeout` lets
 * the kernel forcibly unmount a mount nothing has answered for, which is
 * the only cleanup left when the serving process died without unmounting.
 *
 * `intr` is darwin-only because Linux has ignored it since 2.6.25, where
 * `soft` is the whole answer.
 */
export function mountOptions(
  port: number,
  config: NFSConfig,
  platform: string = process.platform,
): string {
  const darwin = platform === 'darwin'
  const bare = String(port)
  const parts = [
    darwin ? 'nolocks' : 'nolock',
    'vers=3',
    'tcp',
    'rsize=131072',
    'actimeo=0',
    `port=${bare}`,
    `mountport=${bare}`,
    `timeo=${String(config.timeo)}`,
    `retrans=${String(config.retrans)}`,
  ]
  if (config.soft) parts.push('soft')
  if (darwin) {
    parts.push('intr')
    if (config.deadTimeout > 0) parts.push(`deadtimeout=${String(config.deadTimeout)}`)
  }
  return parts.join(',')
}

/** The kernel mount command for one export. */
export function mountArgs(
  mountpoint: string,
  port: number,
  exportPath: string,
  config: NFSConfig = new NFSConfig(),
  platform: string = process.platform,
): [string, ...string[]] {
  // The host the server was bound to, not a hardcoded loopback: a
  // config naming another address (127.0.0.2, a second loopback alias)
  // binds there and would otherwise be mounted from an address nothing
  // is listening on.
  const source = `${config.host}:${exportPath}`
  const opts = mountOptions(port, config, platform)
  if (platform === 'darwin') return ['mount_nfs', '-o', opts, source, mountpoint]
  return ['mount', '-t', 'nfs', '-o', opts, source, mountpoint]
}

/**
 * The unmount command for a mountpoint.
 *
 * `umount -f` is the NFS force path on both platforms, and it is the one
 * that answers when the server behind the mount is already gone: a plain
 * unmount asks the filesystem to flush first, which is a request nothing
 * is left to serve.
 */
export function umountArgs(
  mountpoint: string,
  force = false,
  _platform: string = process.platform,
): [string, ...string[]] {
  return force ? ['umount', '-f', mountpoint] : ['umount', mountpoint]
}

/**
 * The unmount of last resort, which differs by platform.
 *
 * Linux has `umount -l`: a lazy detach is a namespace operation, so it
 * succeeds without asking the filesystem anything and takes the
 * mountpoint out of every path lookup immediately, with the old mount
 * surviving only for handles already open. macOS has no lazy unmount at
 * all -- its `umount` takes only `-fv` -- so the last rung there is
 * `diskutil`, which asks the volume layer instead.
 */
export function lastResortArgs(
  mountpoint: string,
  platform: string = process.platform,
): [string, ...string[]] {
  if (platform === 'darwin') return ['diskutil', 'unmount', 'force', mountpoint]
  return ['umount', '-l', mountpoint]
}

/** Resolve the mountpoint, creating a temporary one when unnamed. */
export function prepareMountpoint(mountpoint?: string): [string, boolean] {
  if (mountpoint !== undefined && mountpoint !== '') {
    mkdirSync(mountpoint, { recursive: true })
    return [mountpoint, false]
  }
  return [mkdtempSync(join(tmpdir(), 'mirage-nfs-')), true]
}

/**
 * Whether the kernel has a filesystem mounted at `path`.
 *
 * `os.path.ismount`'s rule, which is the readiness signal the FSKit
 * lesson demands: a mountpoint directory existing is not a mount. It is
 * CPython's `genericpath.ismount` line for line — lstat both sides, a
 * symlink is never a mount, the parent is reached as `path/..` (so a
 * relative path works, where `dirname` would answer the empty string),
 * a differing device means a boundary and a shared inode means a root.
 *
 * Both stats are async on purpose: over NFS the stat is served by this
 * very event loop, and a synchronous one would block the loop that has
 * to answer it.
 */
export async function isMountPoint(path: string): Promise<boolean> {
  try {
    const self = await lstat(path)
    if (self.isSymbolicLink()) return false
    const parent = await lstat(join(path, '..'))
    return self.dev !== parent.dev || self.ino === parent.ino
  } catch {
    // the path is gone or unreadable: not a live mount either way
    return false
  }
}

/**
 * Wait until the kernel reports a live mount, or fail loudly.
 *
 * Every probe is bounded, not just the loop around them. A probe is a
 * stat, and a stat of a mount whose server never answers does not
 * resolve -- so a deadline checked only between probes is a deadline
 * that never fires, and the wait that was supposed to fail after ten
 * seconds hangs instead. The abandoned probe stays pending on a libuv
 * thread; that is the cost of not hanging the loop, and it is bounded
 * by the deadline above.
 */
export async function awaitIsMount(
  mountpoint: string,
  timeout: number = MOUNT_TIMEOUT_SECONDS,
  probe: (path: string) => Promise<boolean> = isMountPoint,
  probeTimeout: number = PROBE_TIMEOUT_SECONDS,
): Promise<void> {
  const deadline = Date.now() + timeout * 1000
  while (Date.now() < deadline) {
    const answered = await Promise.race([
      probe(mountpoint),
      new Promise<null>((wake) =>
        setTimeout(() => {
          wake(null)
        }, probeTimeout * 1000),
      ),
    ])
    if (answered === true) return
    await new Promise((wake) => setTimeout(wake, POLL_SECONDS * 1000))
  }
  throw new Error(
    `nfs mount at ${JSON.stringify(mountpoint)} did not come up within ${String(timeout)}s`,
  )
}

export async function runMount(
  mountpoint: string,
  port: number,
  exportPath: string,
  config: NFSConfig = new NFSConfig(),
): Promise<void> {
  const [program, ...argv] = mountArgs(mountpoint, port, exportPath, config)
  try {
    await run(program, argv)
  } catch (err) {
    const failure = err as { code?: number | string; stdout?: string; stderr?: string }
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim()
    const reason = output === '' ? String(err) : output
    throw new Error(`${program} failed (${String(failure.code ?? 1)}): ${reason}`)
  }
  await awaitIsMount(mountpoint, MOUNT_TIMEOUT_SECONDS, isMountPoint)
}

/**
 * Run a teardown command, giving up rather than waiting forever.
 *
 * `execFile`'s own `timeout` is not enough: it signals the child at the
 * deadline and settles when the child exits, and a child stuck in an
 * uninterruptible kernel wait on a dead mount never does. The race is
 * what bounds the caller; the SIGKILL is a courtesy the child may well
 * ignore, which is why it is unref'd and never awaited again.
 *
 * @returns the exit status, or null if it outlived the wait
 */
export type BoundedRunner = (
  program: string,
  argv: string[],
  timeout: number,
) => Promise<number | null>

const runBounded: BoundedRunner = async (program, argv, timeout) => {
  const child = spawn(program, argv, { stdio: 'ignore' })
  return await new Promise<number | null>((settle) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      child.unref()
      settle(null)
    }, timeout * 1000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      settle(code ?? 1)
    })
    child.once('error', () => {
      clearTimeout(timer)
      settle(null)
    })
  })
}

/**
 * Unmount, escalating, and never blocking forever.
 *
 * Four rungs, each bounded: a plain unmount, the same one again after a
 * pause, `umount -f`, and the platform's last resort (`umount -l` on
 * linux, `diskutil unmount force` on darwin). Every one of them can
 * block in the kernel when the mount's server has stopped answering,
 * which is exactly when teardown is being asked to run, so the wait is
 * what has to be bounded rather than the outcome trusted.
 *
 * The retry is the EBUSY rung, and it only runs when the first attempt
 * *answered*: a busy target is usually a child that has not finished
 * exiting, and one that answered will answer again in milliseconds. A
 * first attempt that timed out is a wedged mount instead, where a
 * second plain unmount would only spend the same wait again, so that
 * case escalates straight to force. The runner reports a status, not an
 * errno, so the rung is not conditioned on EBUSY itself -- checking
 * that would mean parsing umount's wording in whatever locale it was
 * written for.
 *
 * Failing every rung leaves a live mount whose server is about to stop,
 * which is the state that wedges a machine, so it is reported with the
 * command that clears it rather than passed over.
 */
export async function runUmount(
  mountpoint: string,
  timeout: number = UMOUNT_TIMEOUT_SECONDS,
  runner: BoundedRunner = runBounded,
  retryPause: number = UMOUNT_RETRY_PAUSE,
): Promise<void> {
  const [plain, ...plainArgv] = umountArgs(mountpoint)
  const answered = await runner(plain, plainArgv, timeout)
  if (answered === 0) return
  if (answered !== null) {
    await new Promise((wake) => setTimeout(wake, retryPause * 1000))
    if ((await runner(plain, plainArgv, timeout)) === 0) return
  }
  const [forced, ...forcedArgv] = umountArgs(mountpoint, true)
  if ((await runner(forced, forcedArgv, timeout)) === 0) return
  const [resort, ...resortArgv] = lastResortArgs(mountpoint)
  if ((await runner(resort, resortArgv, timeout)) === 0) return
  process.stderr.write(
    `mirage: nfs mountpoint ${mountpoint} could not be unmounted; it is still ` +
      'live with no server behind it, which blocks anything that touches it. ' +
      `Clear it with: sudo ${[resort, ...resortArgv].join(' ')}\n`,
  )
}

/**
 * Run the mount guards and start the NFS server for one workspace.
 *
 * The delegate runs on this process's event loop, so the FUSE
 * self-touch rule applies verbatim: never touch the mountpoint
 * synchronously from here, or the call blocks the loop that must answer
 * it.
 *
 * Known limitation of the current addon: the idle-flush task holds its
 * callback for the process's lifetime, so `stop()` ends the exports but
 * does not release node's event loop. A script that mounts and closes
 * still has to `process.exit()`.
 */
export async function startServer(
  ws: Workspace,
  config: NFSConfig = new NFSConfig(),
  session?: Session | null,
): Promise<[NFSFlushable, NFSServerHandle]> {
  await prepareNfsMount('nfs', ws, config)
  const addon = loadAddon()
  const fs = new MirageNFS(ws.fs, config)
  const delegate = buildDelegate(fs, session)
  const uid = process.getuid?.() ?? 0
  const gid = process.getgid?.() ?? 0
  const handle = await addon.start(
    delegate.lookup,
    delegate.getattr,
    delegate.setSize,
    delegate.read,
    delegate.write,
    delegate.create,
    delegate.createExclusive,
    delegate.mkdir,
    delegate.remove,
    delegate.rename,
    delegate.symlink,
    delegate.readlink,
    delegate.readdir,
    delegate.flushIdle,
    config.host,
    config.port,
    fs.rootDir(),
    uid,
    gid,
    config.idleFlushSeconds,
  )
  return [scopedFlush(fs, session), handle]
}
