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

import { classify } from '../../../errors/index.ts'
import { normDir } from '../../../utils/slash.ts'
import { parseMode } from '../../handles/mode.ts'
import { applyOpen } from '../../open.ts'
import type { RuntimeFiles } from '../../files.ts'
import type { MontyFsBits } from './loader.ts'
import { MAX_URANDOM_BYTES, NOT_A_LINK } from './constants.ts'
import { asGuestError, guestError } from './errors.ts'
import { childPaths } from './list.ts'
import { isDirRow, isRegularRow, statResult } from './stat.ts'

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

/** Match Python MontyFs's per-call entropy cap before allocating host memory. */
function urandom(value: unknown): Uint8Array {
  const size = Number(value)
  if (size > MAX_URANDOM_BYTES) {
    throw Object.assign(
      new Error(`os.urandom() size exceeds max_urandom_bytes (${String(MAX_URANDOM_BYTES)})`),
      { name: 'MemoryError' },
    )
  }
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('invalid os.urandom size')
  const bytes = new Uint8Array(size)
  // Web Crypto accepts at most 64 KiB per call, including in Node.
  for (let offset = 0; offset < size; offset += 65_536) {
    globalThis.crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65_536, size)))
  }
  return bytes
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
 * The host clock as monty's DateTime marker, which the engine turns
 * into a real guest `datetime`. No timezone argument means python's
 * naive local now; a TimeZone marker means an aware now in that
 * offset — both exactly what the python engine's default
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

// The calls that read or change content: only a path in the runtime's
// view may reach the adapter with one. Structural questions ask of any
// path; a mkdir checks the view itself, after its existence probe.
const CONTENT = new Set([
  'open',
  'Path.read_text',
  'Path.read_bytes',
  'Path.write_text',
  'Path.write_bytes',
  'Path.append_text',
  'Path.append_bytes',
  'Path.rmdir',
  'Path.unlink',
  'Path.rename',
])

/** The predicates, which answer false where there is no filesystem. */
const PROBES = new Set(['Path.exists', 'Path.is_file', 'Path.is_dir', 'Path.is_symlink'])

/** The other calls this adapter serves, which refuse where there is none. */
const STRUCTURE = new Set(['Path.mkdir', 'Path.iterdir', 'Path.stat'])

/**
 * Monty's OS callbacks: every path a guest names is the workspace's.
 *
 * This is monty's tier of the interception taxonomy: the engine calls
 * one host callback per operation and takes back a value (or a promise
 * of one) or NOT_HANDLED, which the sandbox raises as the call's
 * default refusal. Every path goes to the file adapter, and nothing is
 * kept aside: structure is open (a listing, whether a name is a
 * directory or a link) and content goes only through the runtime's
 * view (`RuntimeFiles.serves`: the announced mounts and what a link
 * reaches), so a guest lists what a shell lists and reads and writes
 * nothing the view withholds. The python twin answers the same way.
 * Declining is reserved for an operation these callbacks do not implement.
 *
 * Monty hands the callbacks whole-file calls: an open, then reads of the
 * whole file and appends of each new write. So an open applies its
 * mode's effect on the mount (`applyOpen`) and nothing else, and each
 * write after it ships only its own bytes.
 *
 * Args:
 *   bits: the loaded engine's callback pieces (NOT_HANDLED sentinel
 *     and the MontyFileHandle an `open` answer must be).
 *   env: the run's environment, readable both ways python's monty
 *     spells it (`os.getenv` and `os.environ`).
 *   files: the execution's file adapter, or null outside a workspace,
 *     where every path is out of view.
 */
export class MontyFs {
  private readonly bits: MontyFsBits
  private readonly notHandled: symbol
  private readonly fileHandle: MontyFsBits['MontyFileHandle']
  private readonly env: Record<string, string>
  private readonly files: RuntimeFiles | null

  constructor(bits: MontyFsBits, env: Record<string, string>, files: RuntimeFiles | null) {
    this.bits = bits
    this.notHandled = bits.NOT_HANDLED
    this.fileHandle = bits.MontyFileHandle
    this.env = env
    this.files = files
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
      // KeyError. A copy, like python's environ: a guest that mutates
      // it cannot reach the session's own env.
      return { ...this.env }
    }
    // The clock callbacks: python's engine defaults these to the host
    // clock, so declining them (a guest RuntimeError) was a divergence
    // for any program that stamps its output.
    if (name === 'datetime.now') return dateTimeMarker(timeZoneArg(args[0]))
    if (name === 'date.today') return dateMarker()
    if (name === 'os.urandom') return urandom(args[0])
    // Everything below serves a path; the callbacks above need none.
    const path = pathArg(args[0])
    if (path === null) return this.notHandled
    // Lexical questions need no mount: resolve() is absolute() and '/'
    // is the working directory, which is also what python's engine
    // answers (a str, on both hosts).
    if (name === 'Path.resolve' || name === 'Path.absolute') {
      return path.startsWith('/') ? path : '/' + path
    }
    const files = this.files
    if (files === null) return this.unbound(name, path)
    const out =
      CONTENT.has(name) && !files.serves(path)
        ? Promise.reject(guestError('ENOENT', path))
        : this.op(name, path, args, kwargs, files)
    if (!(out instanceof Promise)) return out
    // A mount words its refusals its own way; the guest catches the
    // builtin CPython raises and may print its message.
    const target = name === 'Path.rename' ? (pathArg(args[1]) ?? undefined) : undefined
    return out.catch((caught: unknown) => {
      throw asGuestError(caught, path, target)
    })
  }

  /** Outside a workspace there is no filesystem: probes answer false, the rest refuse. */
  private unbound(name: string, path: string): unknown {
    if (PROBES.has(name)) return false
    if (CONTENT.has(name) || STRUCTURE.has(name)) throw guestError('ENOENT', path)
    return this.notHandled
  }

  private op(
    name: string,
    path: string,
    args: unknown[],
    kwargs: Record<string, unknown>,
    files: RuntimeFiles,
  ): unknown {
    switch (name) {
      case 'open':
        return this.open(path, typeof args[1] === 'string' ? args[1] : 'r', files)
      case 'Path.read_bytes':
        return files.read(path)
      case 'Path.read_text':
        return files.read(path).then((b) => new TextDecoder().decode(b))
      case 'Path.write_bytes':
      case 'Path.write_text':
        return this.write(path, args[1], files)
      case 'Path.append_bytes':
      case 'Path.append_text':
        return this.append(path, args[1], files)
      case 'Path.mkdir':
        return this.mkdir(path, kwargs, files)
      case 'Path.rmdir':
        return files.rmdir(path).then(() => null)
      case 'Path.unlink':
        return files.unlink(path).then(() => null)
      case 'Path.rename': {
        const dst = pathArg(args[1])
        if (dst === null) return this.notHandled
        return files.rename(path, dst).then(() => null)
      }
      case 'Path.iterdir':
        return files.readdir(normDir(path), false).then((entries) =>
          childPaths(
            path,
            entries.map((e) => e.path),
          ),
        )
      // The predicates read the row the view shows: the mount's own,
      // or a directory the workspace lists.
      case 'Path.is_dir':
        return files.viewStat(path).then((st) => st !== null && isDirRow(st))
      case 'Path.is_symlink':
        return this.isLink(path, files)
      case 'Path.is_file':
        return files.viewStat(path).then((st) => st !== null && isRegularRow(st))
      case 'Path.exists':
        return files.viewStat(path).then((st) => st !== null)
      case 'Path.stat':
        return files.viewStat(path).then((st) => {
          if (st === null) throw guestError('ENOENT', path)
          return statResult(this.bits, st)
        })
      default:
        return this.notHandled
    }
  }

  /**
   * Whether the name plane holds a symlink at `path`, asked through
   * readlink. A refusal the backend did not mean as "no link here"
   * comes out as itself (NOT_A_LINK), which is what CPython's own
   * `Path.is_symlink` does.
   */
  private isLink(path: string, files: RuntimeFiles): Promise<boolean> {
    return files.readlink(path).then(
      () => true,
      (caught: unknown) => {
        const condition = classify(caught)
        if (condition === null || !NOT_A_LINK.has(condition)) throw caught
        return false
      },
    )
  }

  private async open(path: string, mode: string, files: RuntimeFiles): Promise<unknown> {
    // Handle first, as monty's own engine does: a malformed mode must
    // raise before any side effect lands on the mount.
    const handle = new this.fileHandle(path, mode)
    await applyOpen(files, path, parseMode(mode))
    return handle
  }

  /** Replace a file; the return is python's: characters for text, bytes for bytes. */
  private async write(path: string, data: unknown, files: RuntimeFiles): Promise<number> {
    const bytes = payloadBytes(data)
    await files.write(path, bytes)
    return typeof data === 'string' ? textLength(data) : bytes.length
  }

  /**
   * Send only the appended bytes; monty hands an append nothing else.
   * Re-sending everything written so far turns a write loop quadratic,
   * so a mount with its own append op carries just these bytes, and the
   * adapter falls back to a whole-file write only for the mount without
   * one. The return is python's: characters for text, bytes for bytes.
   */
  private async append(path: string, data: unknown, files: RuntimeFiles): Promise<number> {
    const tail = payloadBytes(data)
    await files.append(path, tail)
    return typeof data === 'string' ? textLength(data) : tail.length
  }

  /**
   * Create a directory, keeping pathlib's flags: `parents` rides through
   * to the backend op, which takes it; `exist_ok` is answered here,
   * since the op has no such argument and backends differ on whether
   * creating an existing directory raises at all. `exist_ok` forgives
   * an existing directory only — a file at the target still raises,
   * pathlib's own rule.
   */
  private async mkdir(
    path: string,
    kwargs: Record<string, unknown>,
    files: RuntimeFiles,
  ): Promise<null> {
    const row = await files.viewStat(path)
    if (row !== null && !isDirRow(row)) throw guestError('EEXIST', path)
    if (row !== null) {
      if (kwargs.exist_ok === true) return null
      throw guestError('EEXIST', path)
    }
    if (!files.serves(path)) throw guestError('ENOENT', path)
    await files.mkdir(path, kwargs.parents === true)
    return null
  }
}
