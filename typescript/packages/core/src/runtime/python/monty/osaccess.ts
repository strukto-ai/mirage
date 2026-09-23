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

import { mergeEntries } from './list.ts'
import { parseMode } from '../../handles/mode.ts'
import type { MontyBindingBits } from './binding.ts'
import { guestError } from './errors.ts'
import { isDirRow, isRegularRow, statResult } from './stat.ts'
import { ScratchTree } from './tree.ts'
import type { MontyVFS } from './vfs.ts'

function pathArg(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && 'path' in value) {
    const p = (value as { path: unknown }).path
    return typeof p === 'string' ? p : null
  }
  return null
}

/** Character count the way python's `len` counts: code points, not UTF-16 units. */
function textLength(data: unknown): number {
  return Array.from(String(data)).length
}

function payloadBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  return new TextEncoder().encode(typeof data === 'string' ? data : '')
}

function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const out = new Uint8Array(head.length + tail.length)
  out.set(head, 0)
  out.set(tail, head.length)
  return out
}

interface TimeZoneMarker {
  offsetSeconds: number
  name?: string
}

function timeZoneArg(value: unknown): TimeZoneMarker | null {
  if (value === null || typeof value !== 'object') return null
  const marker = value as { __monty_type__?: unknown; offsetSeconds?: unknown; name?: unknown }
  if (marker.__monty_type__ !== 'TimeZone' || typeof marker.offsetSeconds !== 'number') return null
  return {
    offsetSeconds: marker.offsetSeconds,
    ...(typeof marker.name === 'string' ? { name: marker.name } : {}),
  }
}

/**
 * The host clock as monty's DateTime marker, which the binding turns
 * into a real guest `datetime`. No timezone argument means python's
 * naive local now; a TimeZone marker means an aware now in that
 * offset — both exactly what the python binding's default
 * `datetime_now(tz)` answers.
 */
function dateTimeMarker(tz: TimeZoneMarker | null): Record<string, unknown> {
  if (tz === null) {
    const now = new Date()
    return {
      __monty_type__: 'DateTime',
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      hour: now.getHours(),
      minute: now.getMinutes(),
      second: now.getSeconds(),
      microsecond: now.getMilliseconds() * 1000,
    }
  }
  const shifted = new Date(Date.now() + tz.offsetSeconds * 1000)
  return {
    __monty_type__: 'DateTime',
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    microsecond: shifted.getUTCMilliseconds() * 1000,
    offsetSeconds: tz.offsetSeconds,
    ...(tz.name !== undefined ? { timezoneName: tz.name } : {}),
  }
}

function dateMarker(): Record<string, unknown> {
  const now = new Date()
  return {
    __monty_type__: 'Date',
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
  }
}

/**
 * Monty's OS door, serving the guest's `os` and `pathlib` calls.
 *
 * This is monty's tier of the interception taxonomy: the binding calls
 * one host callback per operation and takes back a value (or a promise
 * of one) or NOT_HANDLED, which the sandbox raises as the call's
 * default refusal. That is the whole seam — the JS binding has no tree
 * of its own, unlike the python binding's `OSAccess` — so this side
 * carries both halves itself: a path under a mount answers through
 * `MontyVFS`, and a path under no mount answers from a per-run
 * `ScratchTree`, so `/tmp` really does behave like `/tmp` on both
 * hosts. Declining is reserved for what neither half can serve: an
 * operation this door does not implement.
 *
 * Args:
 *   binding: the loaded binding's door pieces (NOT_HANDLED sentinel
 *     and the MontyFileHandle an `open` answer must be).
 *   env: the run's environment, readable both ways python's monty
 *     spells it (`os.getenv` and `os.environ`).
 *   vfs: the mount view, or null when no workspace is attached.
 */
export class MirageOSAccess {
  private readonly bits: MontyBindingBits
  private readonly notHandled: symbol
  private readonly fileHandle: MontyBindingBits['MontyFileHandle']
  private readonly env: Record<string, string>
  private readonly vfs: MontyVFS | null
  private readonly tree = new ScratchTree()
  // The content each open-for-append handle has accumulated, so an
  // append can ride the delta op with the correct whole-file fallback
  // (python holds the same running content in its in-memory tree).
  private readonly bases = new Map<string, Uint8Array>()

  constructor(binding: MontyBindingBits, env: Record<string, string>, vfs: MontyVFS | null) {
    this.bits = binding
    this.notHandled = binding.NOT_HANDLED
    this.fileHandle = binding.MontyFileHandle
    this.env = env
    this.vfs = vfs
  }

  readonly handle = (
    name: string,
    args: unknown[],
    kwargs: Record<string, unknown> = {},
  ): unknown => {
    if (name === 'os.getenv') {
      // hasOwn, not `in`: the guest picks the key, so a name like
      // `toString` must miss instead of leaking a host function.
      const key = String(args[0])
      if (Object.hasOwn(this.env, key)) return this.env[key]
      return args.length > 1 ? args[1] : null
    }
    if (name === 'os.environ') {
      // The engine asks for the whole mapping as one call; a plain
      // object arrives in the guest as a dict, so `.get`, `[...]`,
      // `in`, iteration and len all work, and a missing key raises
      // KeyError. Declining instead raised "'os.environ' is not
      // supported in this environment", which made a program written
      // against the python host fail here (integ/runtime caught it).
      // A copy, like python's OSAccess(environ=dict(environ)): a
      // guest that mutates it cannot reach the session's own env.
      return { ...this.env }
    }
    // The clock doors: python's binding defaults these to the host
    // clock, so declining them (a guest RuntimeError) was a divergence
    // for any program that stamps its output.
    if (name === 'datetime.now') return dateTimeMarker(timeZoneArg(args[0]))
    if (name === 'date.today') return dateMarker()
    // Everything below serves a path; the doors above need none.
    const path = pathArg(args[0])
    if (path === null) return this.notHandled
    // Lexical questions need no mount and no tree entry: monty's own
    // tree resolves no symlinks, so resolve() is absolute() and '/' is
    // the working directory, which is also what python's binding
    // answers (a str, on both hosts).
    if (name === 'Path.resolve' || name === 'Path.absolute') {
      return path.startsWith('/') ? path : '/' + path
    }
    const vfs = this.vfs
    if (vfs === null) return this.scratchOp(name, path, args, kwargs, vfs)
    if (vfs.serves(path)) return this.mountedOp(name, path, args, kwargs, vfs)
    return this.scratchOp(name, path, args, kwargs, vfs)
  }

  /** A path some mount serves: every answer is the workspace's. */
  private mountedOp(
    name: string,
    path: string,
    args: unknown[],
    kwargs: Record<string, unknown>,
    vfs: MontyVFS,
  ): unknown {
    switch (name) {
      case 'open':
        return this.openMounted(path, typeof args[1] === 'string' ? args[1] : 'r', vfs)
      case 'Path.read_bytes':
        return vfs.read(path)
      case 'Path.read_text':
        return vfs.read(path).then((b) => new TextDecoder().decode(b))
      case 'Path.write_bytes':
      case 'Path.write_text':
        this.bases.set(path, payloadBytes(args[1]))
        return vfs.write(path, args[1])
      case 'Path.append_bytes':
      case 'Path.append_text':
        return this.appendMounted(path, args[1], vfs)
      case 'Path.mkdir':
        return this.mkdirMounted(path, kwargs, vfs)
      case 'Path.rmdir':
        return vfs.rmdir(path)
      case 'Path.unlink':
        this.bases.delete(path)
        return vfs.unlink(path)
      case 'Path.rename': {
        const dst = pathArg(args[1])
        if (dst === null) return this.notHandled
        // A destination outside the workspace crosses out of the
        // mount world; EXDEV is what POSIX answers for a rename
        // across filesystems and what python raises here.
        if (!vfs.serves(dst)) throw guestError('EXDEV', path, dst)
        this.bases.delete(path)
        this.bases.delete(dst)
        return vfs.rename(path, dst)
      }
      case 'Path.iterdir':
        return vfs.readdir(path).then((entries) => entries.map((e) => e.path))
      // The mount's own row answers the three predicates whenever it
      // has one, which is what python's door does. A listing is a
      // second question, not a cheaper spelling of the first: a
      // backend may serve a stat for a path it will not list, and
      // asking the listing first reported that as a failure rather
      // than as the row it had. The fallback stays for the one path
      // with no row of its own, a directory the mount only implies
      // (the root above a nested mount).
      case 'Path.is_dir':
        return vfs
          .stat(path)
          .then((st) =>
            st !== null ? isDirRow(st) : vfs.readdirOrNull(path).then((e) => e !== null),
          )
      // Monty's own tree holds no links, so declining would answer
      // False for one the shell made; the mount's name plane is the
      // only place the fact lives. Creation stays out of reach: the
      // binding emits no symlink verb to serve.
      case 'Path.is_symlink':
        return vfs.isLink(path)
      // No listing fallback here, and that is not an omission: an
      // implied directory is the only path a mount lists without a
      // row, and it is not a regular file.
      case 'Path.is_file':
        return vfs.stat(path).then((st) => st !== null && isRegularRow(st))
      case 'Path.exists':
        return vfs
          .stat(path)
          .then((st) => (st !== null ? true : vfs.readdirOrNull(path).then((e) => e !== null)))
      // A row the mount does not have is not an absence yet: the
      // path may be a guest scratch file, and only the tree knows.
      // `Path.iterdir` strings arriving as guest str (python:
      // PosixPath) remains an upstream gap; the wire has no Path.
      case 'Path.stat':
        return vfs
          .stat(path)
          .then((st) => (st === null ? this.scratchStat(path, vfs) : statResult(this.bits, st)))
      default:
        return this.notHandled
    }
  }

  /** A path no mount serves: the guest's scratch space, answered from the tree. */
  private scratchOp(
    name: string,
    path: string,
    args: unknown[],
    kwargs: Record<string, unknown>,
    vfs: MontyVFS | null,
  ): unknown {
    switch (name) {
      case 'open': {
        const mode = typeof args[1] === 'string' ? args[1] : 'r'
        const handle = new this.fileHandle(path, mode)
        this.tree.open(path, parseMode(mode))
        return handle
      }
      case 'Path.read_text':
        return this.tree.readText(path)
      case 'Path.read_bytes':
        return this.tree.readBytes(path)
      case 'Path.write_text':
        this.tree.write(path, String(args[1]))
        return textLength(args[1])
      case 'Path.write_bytes': {
        const data = payloadBytes(args[1])
        this.tree.write(path, data)
        return data.length
      }
      case 'Path.append_text':
        this.tree.append(path, String(args[1]))
        return textLength(args[1])
      case 'Path.append_bytes': {
        const data = payloadBytes(args[1])
        this.tree.append(path, data)
        return data.length
      }
      case 'Path.mkdir':
        this.tree.mkdir(path, kwargs.parents === true, kwargs.exist_ok === true)
        return null
      case 'Path.unlink':
        this.tree.unlink(path)
        return null
      case 'Path.rmdir':
        this.tree.rmdir(path)
        return null
      case 'Path.rename': {
        const dst = pathArg(args[1])
        if (dst === null) return this.notHandled
        // Crossing into a mount is the same filesystem boundary as
        // crossing out of one.
        if (vfs?.serves(dst) === true) throw guestError('EXDEV', path, dst)
        this.tree.rename(path, dst)
        return null
      }
      case 'Path.exists':
        if (this.tree.exists(path)) return true
        return this.remoteIsDir(path, vfs)
      case 'Path.is_file':
        return this.tree.isFile(path)
      case 'Path.is_dir':
        if (this.tree.isDir(path)) return true
        return this.remoteIsDir(path, vfs)
      case 'Path.is_symlink':
        // The tree holds no links, but the name plane may hold one at
        // an unmounted path; python asks the workspace the same way.
        return vfs === null ? false : vfs.isLink(path)
      case 'Path.iterdir':
        return this.scratchIterdir(path, vfs)
      case 'Path.stat':
        return this.scratchStat(path, vfs)
      default:
        return this.notHandled
    }
  }

  /**
   * The scratch tree's row for `path`, as the guest's `os.stat_result`.
   *
   * A directory the workspace can list but no mount claims (the root
   * above nested mounts, `/parent` when only `/parent/child` is
   * mounted) is not in the tree, and falling straight through reported
   * it missing although `exists` and `is_dir` both answered True for
   * it. So the same door those two use answers here, and a hit is
   * materialized exactly as python's `_ensure_dir` materializes it,
   * which is what keeps the two hosts' rows identical.
   *
   * Args:
   *   path: the guest path to stat.
   *   vfs: the mount view, or null outside a workspace.
   */
  private scratchStat(path: string, vfs: MontyVFS | null): unknown {
    if (this.tree.exists(path)) return statResult(this.bits, this.tree.stat(path))
    const listed = this.remoteIsDir(path, vfs)
    if (listed === false) return statResult(this.bits, this.tree.stat(path))
    return Promise.resolve(listed).then((isDir) => {
      if (isDir) this.tree.mkdir(path, true, true)
      return statResult(this.bits, this.tree.stat(path))
    })
  }

  /**
   * Whether the workspace can list `path` even though no mount claims
   * it: the root of a workspace with nested mounts is the everyday
   * case. Python's tree answers exists/is_dir the same way, by trying
   * the listing.
   */
  private remoteIsDir(path: string, vfs: MontyVFS | null): boolean | Promise<boolean> {
    if (vfs === null) return false
    return vfs.readdirOrNull(path).then((entries) => entries !== null)
  }

  /**
   * List a scratch directory, folding in whatever the workspace can
   * list under the same name — `iterdir('/')` must show the mount
   * roots beside the guest's own scratch entries, as python's merged
   * listing does. A path neither side can list raises the tree's own
   * FileNotFoundError.
   */
  private scratchIterdir(path: string, vfs: MontyVFS | null): unknown {
    if (vfs === null) return this.tree.iterdir(path)
    return vfs.readdirOrNull(path).then((entries) => {
      if (entries === null) return this.tree.iterdir(path)
      return mergeEntries(
        path,
        this.tree.isDir(path) ? this.tree.iterdir(path) : [],
        entries.map((entry) => entry.path),
      )
    })
  }

  private async openMounted(path: string, mode: string, vfs: MontyVFS): Promise<unknown> {
    // Handle first, mirroring monty's own tree: a malformed mode must
    // raise before any side effect lands on the mount.
    const handle = new this.fileHandle(path, mode)
    const facts = parseMode(mode)
    if (facts.exclusive) {
      if ((await vfs.entryFor(path)) !== null) throw guestError('EEXIST', path)
      await vfs.create(path)
      this.bases.set(path, new Uint8Array())
      return handle
    }
    if (facts.truncate) {
      // CPython's open('w') leaves an empty file behind even when
      // nothing is written, so the effect fires at open, not at the
      // first flush.
      if ((await vfs.entryFor(path)) !== null) await vfs.truncate(path)
      else await vfs.create(path)
      this.bases.set(path, new Uint8Array())
      return handle
    }
    if (facts.append) {
      const base = await vfs.readOrNull(path)
      if (base === null) await vfs.create(path)
      this.bases.set(path, base ?? new Uint8Array())
      return handle
    }
    const entry = await vfs.entryFor(path)
    if (entry === null) {
      const listed = await vfs.readdirOrNull(path)
      throw listed !== null ? guestError('EISDIR', path) : guestError('ENOENT', path)
    }
    if (entry.isDir) throw guestError('EISDIR', path)
    // A read follows a link, and a dangling one is listed as its own
    // row with no mode: the name is there, but nothing to open.
    if (entry.isLink === true && entry.mode === undefined) throw guestError('ENOENT', path)
    return handle
  }

  /**
   * Extend a mounted file by `data`, shipping only the delta.
   *
   * Monty hands an append handler the new text alone; the running
   * whole rides beside it so a mount without an append op falls back
   * to one write instead of failing (python keeps the same running
   * content in its tree). The return is python's: characters for
   * text, bytes for bytes.
   */
  private async appendMounted(path: string, data: unknown, vfs: MontyVFS): Promise<number> {
    const tail = payloadBytes(data)
    const base = this.bases.get(path) ?? (await vfs.readOrNull(path)) ?? new Uint8Array()
    const whole = concatBytes(base, tail)
    this.bases.set(path, whole)
    await vfs.append(path, tail, whole)
    return typeof data === 'string' ? textLength(data) : tail.length
  }

  /**
   * Create a mounted directory, keeping pathlib's flags: `parents`
   * rides through to the backend op, which takes it; `exist_ok` is
   * answered here, since the op has no such argument and backends
   * differ on whether creating an existing directory raises at all.
   * `exist_ok` forgives an existing directory only — a file at the
   * target still raises, pathlib's own rule.
   */
  private async mkdirMounted(
    path: string,
    kwargs: Record<string, unknown>,
    vfs: MontyVFS,
  ): Promise<null> {
    const entry = await vfs.entryFor(path)
    if (entry !== null && !entry.isDir) throw guestError('EEXIST', path)
    const exists = entry !== null || (await vfs.readdirOrNull(path)) !== null
    if (exists) {
      if (kwargs.exist_ok === true) return null
      throw guestError('EEXIST', path)
    }
    await vfs.mkdir(path, kwargs.parents === true)
    return null
  }
}
