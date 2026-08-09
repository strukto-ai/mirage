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

import { isMissingOp, isMissingPath } from '../utils/errors.ts'
import { CrossMountError } from './errors.ts'
import type { BridgeDispatchFn, PrefixSource } from './types.ts'

export type FlushKind = 'append' | 'write'

// The lowest offset a handle has written at, before it writes anything.
// A sentinel rather than a null because every write takes the minimum of
// it and the new offset, and "nothing yet" has to lose that comparison.
export const NO_WRITE = Number.MAX_SAFE_INTEGER

/** One directory entry as the mounts report it. */
export interface VFSEntry {
  path: string
  size: number
  isDir: boolean
  // A namespace symlink. Marked so a whole-tree preload can skip it:
  // stat follows links, so a directory link would otherwise read as a
  // plain directory and a cyclic one would recurse the walk forever.
  isLink?: boolean
}

/** One path's metadata, in the shape every guest encoder needs. */
export interface VFSStat {
  size: number
  isDir: boolean
  mtimeMs: number
}

export function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const out = new Uint8Array(head.length + tail.length)
  out.set(head, 0)
  out.set(tail, head.length)
  return out
}

/**
 * Decide what a closing whole-file buffer owes the mount.
 *
 * Every encoder buffers a whole file and has to answer the same
 * question at close: did this handle only add to the end, or did it
 * rewrite what was already there? Only the first can travel as a
 * delta, and answering "write" always is what makes an append loop
 * quadratic.
 *
 * Args:
 *   baseLen: length the file had when the handle opened.
 *   lowWrite: lowest offset this handle wrote at, or the base length
 *     when it never wrote below the end.
 *   buf: the handle's whole buffer.
 *
 * Returns:
 *   ['append', tail] when the handle only extended the file, else
 *   ['write', whole buffer].
 */
export function planFlush(
  baseLen: number,
  lowWrite: number,
  buf: Uint8Array,
): [FlushKind, Uint8Array] {
  if (baseLen > 0 && lowWrite >= baseLen && buf.length >= baseLen) {
    return ['append', buf.slice(baseLen)]
  }
  return ['write', buf.slice()]
}

/**
 * The mount-facing op vocabulary a sandboxed runtime encodes into.
 *
 * One instruction set (read/write/append/stat/readdir/unlink/mkdir/
 * rmdir/rename), one routing table, one place that knows an append may
 * have to become a whole-file write. Encoders hold one of these; they
 * never inherit it, because a monty encoder is the binding's own `os`
 * callback and a quickjs encoder is a table of host functions.
 *
 * The surface is async, unlike Python's: a JS guest either suspends at
 * the call (quickjs asyncify) or records the mutation and replays it
 * after the run (pyodide), so nothing here has to block a worker
 * thread the way the Python runtimes do.
 *
 * Args:
 *   dispatch: the workspace op dispatch this runtime was attached to.
 *   mountPrefixes: live view of the workspace mount prefixes; the
 *     default answers no mounts, so routing questions answer null.
 */
export class RuntimeVFS {
  private readonly dispatch: BridgeDispatchFn
  private readonly mountPrefixes: PrefixSource
  private readonly noAppend = new Set<string>()

  constructor(dispatch: BridgeDispatchFn, mountPrefixes: PrefixSource = () => []) {
    this.dispatch = dispatch
    this.mountPrefixes = mountPrefixes
  }

  /**
   * The workspace mount prefixes, longest first, trailing-slash
   * normalized. Longest first is what makes mountOf's first match the
   * right one when one mount nests inside another.
   */
  prefixes(): string[] {
    const out = this.mountPrefixes().map((p) => (p.endsWith('/') ? p : p + '/'))
    return out.sort((a, b) => b.length - a.length)
  }

  /** The mount prefix serving `path`, longest match first, or null. */
  mountOf(path: string): string | null {
    for (const prefix of this.prefixes()) {
      if (path === prefix.slice(0, -1) || path.startsWith(prefix)) return prefix
    }
    return null
  }

  async read(path: string): Promise<Uint8Array> {
    const out = await this.dispatch('READ', path)
    if (!(out instanceof Uint8Array)) {
      throw new TypeError(`runtime vfs: READ ${path} expected Uint8Array, got ${typeof out}`)
    }
    return out
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const out = await this.dispatch('WRITE', path, bytes)
    if (out !== undefined) {
      throw new TypeError(`runtime vfs: WRITE ${path} expected void, got ${typeof out}`)
    }
  }

  async stat(path: string): Promise<VFSStat> {
    const out = await this.dispatch('STAT', path)
    const st = out as VFSStat | null
    if (
      st === null ||
      typeof st !== 'object' ||
      typeof st.size !== 'number' ||
      typeof st.isDir !== 'boolean' ||
      typeof st.mtimeMs !== 'number'
    ) {
      throw new TypeError(`runtime vfs: STAT ${path} bad shape`)
    }
    return st
  }

  async readdir(path: string): Promise<VFSEntry[]> {
    const out = await this.dispatch('LIST', path)
    if (!Array.isArray(out)) {
      throw new TypeError(`runtime vfs: LIST ${path} expected array`)
    }
    for (const e of out) {
      if (
        e === null ||
        typeof e !== 'object' ||
        typeof (e as VFSEntry).path !== 'string' ||
        typeof (e as VFSEntry).size !== 'number' ||
        typeof (e as VFSEntry).isDir !== 'boolean'
      ) {
        throw new TypeError(`runtime vfs: LIST ${path} bad entry shape`)
      }
    }
    return out as VFSEntry[]
  }

  async unlink(path: string): Promise<void> {
    await this.dispatch('UNLINK', path)
  }

  async mkdir(path: string): Promise<void> {
    await this.dispatch('MKDIR', path)
  }

  async rmdir(path: string): Promise<void> {
    await this.dispatch('RMDIR', path)
  }

  /**
   * Rename within one mount.
   *
   * Args:
   *   src: guest-absolute source path.
   *   dst: guest-absolute destination path.
   *
   * Throws:
   *   CrossMountError: the two ends resolve to different mounts.
   */
  async rename(src: string, dst: string): Promise<void> {
    if (this.mountOf(src) !== this.mountOf(dst)) throw new CrossMountError(src, dst)
    await this.dispatch('RENAME', src, undefined, dst)
  }

  /**
   * Extend `path` by `tail`, falling back to a whole-file write.
   *
   * `append` is optional per backend (S3 registers `write` and
   * `rename` without it), so a mount that declines is remembered: the
   * fallback then costs one failed dispatch per mount rather than one
   * per call.
   *
   * The fallback needs the whole file. An encoder that already holds
   * it (monty's in-memory tree, a closing file handle) passes it; one
   * that does not (pyodide's mutation replay, which recorded only the
   * tail) omits it and the fallback reads the base first. Only a
   * confirmed absence starts from an empty base, since an append may
   * create the file — every other read failure propagates, because
   * writing the tail alone over a file that exists but is momentarily
   * unreadable would replace content this run never saw.
   *
   * Args:
   *   path: guest-absolute virtual path.
   *   tail: only the newly appended bytes.
   *   whole: the file's full content, when the caller has it.
   */
  async append(path: string, tail: Uint8Array, whole?: Uint8Array): Promise<void> {
    if (await this.appendDelta(path, tail)) return
    if (whole !== undefined) {
      await this.write(path, whole)
      return
    }
    let base: Uint8Array = new Uint8Array()
    try {
      base = await this.read(path)
    } catch (err) {
      if (!isMissingPath(err)) throw err
    }
    await this.write(path, concatBytes(base, tail))
  }

  private async appendDelta(path: string, tail: Uint8Array): Promise<boolean> {
    const mount = this.mountOf(path) ?? path
    if (this.noAppend.has(mount)) return false
    try {
      await this.dispatch('APPEND', path, tail)
    } catch (err) {
      if (!isMissingOp(err, 'append')) throw err
      this.noAppend.add(mount)
      return false
    }
    return true
  }

  /**
   * Send a closing handle's buffer as a delta when it can be one.
   *
   * Args:
   *   path: guest-absolute virtual path.
   *   baseLen: length the file had when the handle opened.
   *   lowWrite: lowest offset this handle wrote at.
   *   buf: the handle's whole buffer.
   */
  async flush(path: string, baseLen: number, lowWrite: number, buf: Uint8Array): Promise<void> {
    const [kind, payload] = planFlush(baseLen, lowWrite, buf)
    if (kind === 'write') {
      await this.write(path, payload)
      return
    }
    await this.append(path, payload, buf)
  }
}
