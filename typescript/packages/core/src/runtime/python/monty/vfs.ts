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
import type { RuntimeVFS, VFSEntry, VFSStat } from '../../vfs.ts'
import { classify, type FsCondition } from '../../../errors/index.ts'
import { asGuestError, guestError } from './errors.ts'

// What counts as "nothing here" depends on what was asked, so there is
// one list per question rather than one list for the class.
//
// A read asks for BYTES, and a directory is a legitimate way to have
// none of them.
const ABSENT_CONTENT = new Set(['FileNotFoundError', 'IsADirectoryError', 'NotADirectoryError'])
// A stat and a listing both ask whether the path IS THERE, and there a
// directory is the answer rather than its absence: reading
// IsADirectoryError as a miss would send the guest to the scratch tree
// for a path the mount holds. Nothing else belongs in either set. A
// backend that refused the op has not said the path is gone, and
// folding that refusal into "no" reports a permission or a transport
// failure as an absence the guest cannot tell from a real one.
const ABSENT_PATH = new Set(['FileNotFoundError', 'NotADirectoryError'])
// What a refused readlink is allowed to mean "no link here". EINVAL is
// the backend saying the path is not one, and the other three are
// CPython's own `_ignore_error` list, which is what `Path.is_symlink`
// swallows around its lstat (EBADF has no condition here, since no
// backend answers on a descriptor). Everything else propagates, the
// same rule the two sets above draw and for the same reason: CPython
// re-raises PermissionError out of `is_symlink`, and reporting a
// refusal as "not a link" is an answer the guest cannot tell from one.
const NOT_A_LINK = new Set<FsCondition>(['EINVAL', 'ENOENT', 'ENOTDIR', 'ELOOP'])

function isAbsence(err: unknown, names: Set<string>): boolean {
  return err instanceof Error && names.has(err.name)
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
 * Only a question about EXISTENCE may feed that cache. A failed read
 * proves nothing about the path: a ram mount reports a read of a
 * directory as FileNotFoundError, so a read that recorded its miss
 * made every later `stat`, `is_dir` and `exists` of that directory
 * answer from monty's own tree defaults instead of the mount's row —
 * the exact divergence the bridged stat exists to remove.
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
      throw asGuestError(caught, path)
    }
  }

  /**
   * The file's bytes, or null when the mount does not have it — the
   * shape python's `MontyVFS.read` answers, for callers that need
   * "missing" as a value (an append's base) rather than a raise.
   */
  readOrNull(path: string): Promise<Uint8Array | null> {
    return this.orNull(path, ABSENT_CONTENT, () => this.core.read(path))
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
    this.established(path)
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
    this.established(path)
    return out
  }

  /** Establish an empty file, the open-time effect of 'w'/'a' on a missing path. */
  async create(path: string): Promise<null> {
    const out = await this.mutate(path, () => this.core.create(path))
    this.established(path)
    return out
  }

  /** Discard content, the open-time effect of 'w' on an existing path. */
  async truncate(path: string): Promise<null> {
    const out = await this.mutate(path, () => this.core.truncate(path))
    this.established(path)
    return out
  }

  async mkdir(path: string, parents = false): Promise<null> {
    const out = await this.mutate(path, () => this.core.mkdir(path, parents))
    this.established(path)
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
    this.establishedTree(dst)
    return null
  }

  /**
   * The directory's entries, or null when there is nothing to list:
   * no path there, or a path that is not a directory. The twin of
   * python's `MontyVFS.readdir`, for the callers that answer a
   * predicate from a listing.
   *
   * It runs past the negative cache in both directions, as python's
   * does, because the self-heal that materializes a directory into
   * monty's own tree lists a path a stat just missed.
   *
   * Args:
   *   path: the directory to list.
   */
  async readdirOrNull(path: string): Promise<VFSEntry[] | null> {
    try {
      return await this.readdir(path)
    } catch (caught) {
      if (!isAbsence(caught, ABSENT_PATH)) throw caught
      return null
    }
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
   * Answered through the readlink op, exactly as python's `is_link`
   * is, and deliberately not through the parent's listing mark. The
   * mark is only reachable behind `entryFor`, which consults the
   * negative cache, and a DANGLING link is the case that breaks on:
   * the guest's own `exists()` stats it, the stat follows the link
   * and misses, the path is remembered as absent, and `is_symlink()`
   * then answered False for a link that is plainly there. The mark
   * was worth that coupling while `exists` and `is_file` already went
   * through the same listing; they ask the row now, so reading it
   * here would also buy a readdir plus a stat per sibling to answer
   * about one path.
   *
   * A refusal the backend did not mean as "no link here" comes out as
   * itself (see NOT_A_LINK), which is what CPython's own
   * `Path.is_symlink` does with anything outside `_ignore_error`.
   *
   * Args:
   *   path: the path to test.
   */
  isLink(path: string): Promise<boolean> {
    return this.core.readlink(path).then(
      () => true,
      (caught: unknown) => {
        const condition = classify(caught)
        if (condition === null || !NOT_A_LINK.has(condition)) throw asGuestError(caught, path)
        return false
      },
    )
  }

  /**
   * The path's row, or null when the mount does not have it.
   *
   * Null rather than a throw, because the caller's next move is the
   * scratch tree: a path no mount holds may still be a guest temp
   * file, and only the tree knows. The twin of python's
   * `MontyVFS.stat`, down to the three absences it remembers.
   *
   * Args:
   *   path: the path to stat.
   */
  async stat(path: string): Promise<VFSStat | null> {
    const row = await this.orNull(path, ABSENT_PATH, () => this.core.stat(path))
    if (row === null) this.missing.add(path)
    return row
  }

  /**
   * The parent's entry for `path`, or null when the parent lacks one
   * or has no listing to lack it in. A parent the mount refuses to
   * list is neither, and raises.
   */
  async entryFor(path: string): Promise<VFSEntry | null> {
    if (this.missing.has(path)) return null
    const slash = path.lastIndexOf('/')
    const parent = slash <= 0 ? '/' : path.slice(0, slash)
    const entries = await this.readdirOrNull(parent)
    const found = entries?.find((e) => e.path === path || e.path === path + '/') ?? null
    if (found === null) this.missing.add(path)
    return found
  }

  /**
   * Forget every absence a creation just invalidated: the path itself
   * and the ancestors it may have brought into being with it.
   *
   * `mkdir(parents=true)` is the obvious one, but a write has the
   * same shape on a prefix store, where the key materializes every
   * directory above it. Forgetting the leaf alone left an ancestor
   * the guest had already asked about cached as missing, so a later
   * stat of it skipped the mount's row and answered from the scratch
   * tree with a synthetic mode and stamp.
   *
   * Args:
   *   path: the path that now exists.
   */
  private established(path: string): void {
    this.missing.delete(path)
    for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/', slash - 1)) {
      this.missing.delete(path.slice(0, slash))
    }
  }

  /**
   * Forget the absences a rename invalidated at its destination:
   * everything `established` forgets, plus everything UNDER the
   * destination.
   *
   * A rename is the one op here that can make a whole subtree exist at
   * once, and a cached absence never self-heals, because the cache
   * answers before the dispatch ever runs. So a child the guest had
   * asked about before the move went on reading as missing after it,
   * for the rest of the run.
   *
   * Args:
   *   path: the directory that now exists, with its contents.
   */
  private establishedTree(path: string): void {
    this.established(path)
    const prefix = path.endsWith('/') ? path : path + '/'
    for (const cached of this.missing) {
      if (cached.startsWith(prefix)) this.missing.delete(cached)
    }
  }

  /**
   * Run one op, answering null for an absence rather than raising, and
   * short-circuiting a path already known not to exist.
   *
   * It records nothing itself: only the caller that asked the
   * existence question may feed the cache. Args:
   *   path: the path the operation named.
   *   names: what counts as "nothing here" for this question.
   *   run: the op to attempt.
   */
  private async orNull<T>(
    path: string,
    names: Set<string>,
    run: () => Promise<T>,
  ): Promise<T | null> {
    if (this.missing.has(path)) return null
    try {
      return await run()
    } catch (caught) {
      const guest = asGuestError(caught, path)
      if (!isAbsence(guest, names)) throw guest
      return null
    }
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
