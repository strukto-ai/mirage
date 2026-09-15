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

import { CrossMountError } from '../../errors.ts'
import type { RuntimeVFS, VFSEntry } from '../../vfs.ts'
import { asGuestError, guestError } from './errors.ts'

// The three ways a mount says "there is nothing here", as opposed to
// "I could not reach it": only these may be remembered as absence.
const ABSENT_NAMES = new Set(['FileNotFoundError', 'IsADirectoryError', 'NotADirectoryError'])

function isAbsence(err: unknown): boolean {
  return err instanceof Error && ABSENT_NAMES.has(err.name)
}

/**
 * Monty's mount view: the shared core, spelled the way the binding
 * needs it, plus a negative cache.
 *
 * Three things the core deliberately does not do live here. Every
 * failure is re-thrown under its python exception name, because the
 * binding turns `err.name` into the guest exception type and agent
 * code catches `FileNotFoundError`, not a bare Error. A path outside
 * every mount is *declined* rather than failed, so monty falls back to
 * its own in-memory tree; the core's `mountOf` answers null for both
 * "no mounts wired" and "not under one", which are different questions
 * here. And a path the mount already answered "not there" for is
 * remembered, because monty asks whether a path exists on nearly every
 * guest expression and each miss otherwise costs a fresh listing;
 * every mutation keeps the cache honest.
 *
 * Args:
 *   core: the shared op vocabulary.
 */
export class MontyVFS {
  private readonly core: RuntimeVFS
  private readonly missing = new Set<string>()

  constructor(core: RuntimeVFS) {
    this.core = core
  }

  /** Forget cached absences when a caller reuses this view. Runtimes create one per run. */
  reset(): void {
    this.missing.clear()
  }

  /**
   * True when `path` may be serviced by the mounts. An empty live view
   * means no scoping: every path routes to the workspace.
   */
  serves(path: string): boolean {
    const prefixes = this.core.prefixes()
    if (prefixes.length === 0) return true
    return this.core.mountOf(path) !== null
  }

  async read(path: string): Promise<Uint8Array> {
    if (this.missing.has(path)) throw guestError('ENOENT', path)
    try {
      return await this.core.read(path)
    } catch (caught) {
      throw this.absent(path, asGuestError(caught, path))
    }
  }

  /**
   * The file's bytes, or null when the mount does not have it — the
   * shape python's `MontyVFS.read` answers, for callers that need
   * "missing" as a value (an append's base) rather than a raise.
   */
  async readOrNull(path: string): Promise<Uint8Array | null> {
    if (this.missing.has(path)) return null
    try {
      return await this.core.read(path)
    } catch (caught) {
      const guest = asGuestError(caught, path)
      if (!isAbsence(guest)) throw guest
      this.missing.add(path)
      return null
    }
  }

  async write(path: string, data: unknown): Promise<number> {
    const bytes =
      data instanceof Uint8Array
        ? data
        : new TextEncoder().encode(typeof data === 'string' ? data : '')
    try {
      await this.core.write(path, bytes)
    } catch (caught) {
      throw asGuestError(caught, path)
    }
    this.missing.delete(path)
    // Characters the way python's len counts them (code points), which
    // is what pathlib's write_text returns to the guest.
    return typeof data === 'string' ? Array.from(data).length : bytes.length
  }

  /**
   * Extend `path` by `tail`, shipping only the delta when the mount
   * takes one; `whole` is the running content for the write fallback
   * (S3 registers `write` without `append`).
   */
  async append(path: string, tail: Uint8Array, whole: Uint8Array): Promise<null> {
    const out = await this.mutate(path, () => this.core.append(path, tail, whole))
    this.missing.delete(path)
    return out
  }

  /** Establish an empty file, the open-time effect of 'w'/'a' on a missing path. */
  async create(path: string): Promise<null> {
    const out = await this.mutate(path, () => this.core.create(path))
    this.missing.delete(path)
    return out
  }

  /** Discard content, the open-time effect of 'w' on an existing path. */
  async truncate(path: string): Promise<null> {
    const out = await this.mutate(path, () => this.core.truncate(path))
    this.missing.delete(path)
    return out
  }

  async mkdir(path: string, parents = false): Promise<null> {
    const out = await this.mutate(path, () => this.core.mkdir(path, parents))
    this.missing.delete(path)
    return out
  }

  async rmdir(path: string): Promise<null> {
    const out = await this.mutate(path, () => this.core.rmdir(path))
    this.missing.add(path)
    return out
  }

  async unlink(path: string): Promise<null> {
    const out = await this.mutate(path, () => this.core.unlink(path))
    this.missing.add(path)
    return out
  }

  /**
   * Rename within one mount, spelling a cross-mount pair as EXDEV.
   *
   * POSIX answers EXDEV for a rename across filesystems, which is also
   * what tells a caller to copy instead. Monty ships no `shutil`, so
   * its own code has to write that fallback by hand; the runtimes with
   * a real stdlib get it from `shutil.move`, which retries on exactly
   * this errno.
   *
   * Args:
   *   src: the rename source.
   *   dst: the rename destination.
   */
  async rename(src: string, dst: string): Promise<null> {
    try {
      await this.core.rename(src, dst)
    } catch (caught) {
      if (caught instanceof CrossMountError) throw guestError('EXDEV', src, dst)
      throw asGuestError(caught, src)
    }
    this.missing.add(src)
    this.missing.delete(dst)
    return null
  }

  /** The directory's entries. Throws when it is not a directory. */
  async readdir(path: string): Promise<VFSEntry[]> {
    const prefix = path.endsWith('/') ? path : path + '/'
    try {
      return await this.core.readdir(prefix)
    } catch (caught) {
      throw asGuestError(caught, path)
    }
  }

  /**
   * Whether the mount's name plane holds a symlink at `path`.
   *
   * Read off the parent's listing, which the door already marks, so a
   * predicate the guest asks per path costs no dispatch of its own
   * beyond the one `entryFor` was going to make. A parent that will
   * not list answers False, the same as pathlib does for a path it
   * cannot reach.
   *
   * Args:
   *   path: the path to test.
   */
  isLink(path: string): Promise<boolean> {
    return this.entryFor(path).then(
      (e) => e?.isLink === true,
      () => false,
    )
  }

  /** The parent's entry for `path`, or null when the parent lacks one. */
  async entryFor(path: string): Promise<VFSEntry | null> {
    if (this.missing.has(path)) return null
    const slash = path.lastIndexOf('/')
    const parent = slash <= 0 ? '/' : path.slice(0, slash)
    const entries = await this.readdir(parent)
    const found = entries.find((e) => e.path === path || e.path === path + '/') ?? null
    if (found === null) this.missing.add(path)
    return found
  }

  /**
   * Remember `path` as absent when `err` says it is, then hand the
   * error back for throwing. A transport failure is not an absence,
   * so only the three fs codes that mean "nothing here" are cached.
   *
   * Args:
   *   path: the path the operation named.
   *   err: the guest-shaped error the op failed with.
   */
  private absent(path: string, err: unknown): unknown {
    if (isAbsence(err)) this.missing.add(path)
    return err
  }

  private async mutate(path: string, run: () => Promise<void>): Promise<null> {
    try {
      await run()
    } catch (caught) {
      throw asGuestError(caught, path)
    }
    return null
  }
}
