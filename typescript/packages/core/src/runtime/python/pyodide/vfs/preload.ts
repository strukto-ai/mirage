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

import { ConcurrencyLimiter } from '../../../../concurrency/limiter.ts'
import { LISTING_ENTRY_CONCURRENCY } from '../../../constants.ts'
import { isMissingPath } from '../../../../utils/errors.ts'
import { isUnclassified, type RuntimeVFS, type VFSEntry, type VFSStat } from '../../../vfs.ts'

export interface FSLike {
  mkdirTree(path: string): void
  writeFile(path: string, bytes: Uint8Array): void
  /** Note a character device without materializing its content. */
  charDevice?(path: string, mode: number, rdev: number): void
  /**
   * Note a listed file whose content could not be fetched. A target that
   * does not implement this simply omits the file, which is only safe
   * when nothing will write to it.
   */
  markUnreadable?(path: string): void
  /**
   * Note a listed entry the mount would not stat. A target that does not
   * implement this omits the entry, as it omits an unreadable file.
   */
  markUnclassified?(path: string): void
  /**
   * Note a namespace symlink and its target. A target that cannot hold
   * links omits them, which is what every seed did before links were
   * reachable at all.
   */
  symlink?(path: string, target: string): void
  /**
   * The mount's permission bits for a path already written. Spelled the
   * way Emscripten's own FS spells it, so a target that is a real FS
   * satisfies it as it stands; a target with no notion of a mode omits
   * it and its files keep the tree's default.
   */
  chmod?(path: string, mode: number): void
  /** The mount's stamps, in milliseconds, as Emscripten's FS takes them. */
  utime?(path: string, atimeMs: number, mtimeMs: number): void
}

/**
 * Carry a row's mode and stamp onto the target it was just written to.
 *
 * The row already holds both (the door stats every entry it does not
 * slash-mark, and leaves both off one it could not classify), so this
 * costs no extra call. Without it a seeded tree
 * reports the tree's own defaults: 0o644 whatever the mount says, and
 * an mtime of the moment the node was built, so every file a guest
 * stats looks like it was modified this second.
 *
 * A slash-marked or unclassified row carries neither and is left
 * alone; so is a link, whose mode is fixed at 0o777 on every POSIX
 * system.
 */
function applyMeta(fs: FSLike, entry: VFSEntry): void {
  if (entry.mode !== undefined) fs.chmod?.(entry.path, entry.mode)
  if (entry.mtimeMs !== undefined) fs.utime?.(entry.path, entry.mtimeMs, entry.mtimeMs)
}

/**
 * Run one of the walk's requests under its shared cap.
 *
 * Held around a single request and released before anything else is
 * awaited, never across a subtree: a directory that kept its slot
 * while its children waited for one could starve the walk.
 */
async function held<T>(limiter: ConcurrencyLimiter, request: () => Promise<T>): Promise<T> {
  const release = await limiter.acquire()
  try {
    return await request()
  } finally {
    release()
  }
}

async function preloadEntry(
  fs: FSLike,
  vfs: RuntimeVFS,
  entry: VFSEntry,
  limiter: ConcurrencyLimiter,
): Promise<void> {
  // A namespace symlink is copied as a link, never followed: stat
  // reports the target, so a directory link would copy its whole
  // subtree here and a cyclic one would never terminate. The target is
  // one readlink, which the walk pays only for the entries the
  // namespace already marked.
  if (entry.isLink === true) {
    if (fs.symlink === undefined) return
    try {
      fs.symlink(entry.path, await held(limiter, () => vfs.readlink(entry.path)))
    } catch (err) {
      // A link the namespace listed and then would not resolve: leaving
      // it out is the honest seed, since inventing a target would make
      // the guest read some other file's bytes.
      console.warn(
        `mirage preload: cannot read link ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return
  }
  if (isUnclassified(entry)) {
    // The door's stat of this entry failed, and the guest will have no
    // way to ask again once the run starts, so this is its stat: an
    // answer seeds the entry as what the mount says it is, an entry
    // that is gone stays out, and any other failure seeds a node that
    // refuses both stat and open.
    let st: VFSStat
    try {
      st = await held(limiter, () => vfs.stat(entry.path))
    } catch (err) {
      if (isMissingPath(err)) return
      fs.markUnclassified?.(entry.path)
      console.warn(
        `mirage preload: cannot stat ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return
    }
    await preloadEntry(fs, vfs, { path: entry.path, ...st }, limiter)
    return
  }
  if (entry.isDir) {
    fs.mkdirTree(entry.path)
    applyMeta(fs, entry)
    const next = entry.path.endsWith('/') ? entry.path : entry.path + '/'
    if (vfs.mountOf(entry.path) === next) {
      // A nested mount served through its parent keeps the failure
      // boundary it had as a top-level prefix: its root readdir failing
      // must fail the whole collection, so syncMounts keeps the
      // previous healthy snapshot instead of replacing it with one
      // where this subtree reads as empty.
      await preloadInto(fs, vfs, next, limiter)
      return
    }
    try {
      await preloadInto(fs, vfs, next, limiter)
    } catch (err) {
      console.warn(
        `mirage preload: skipping subtree ${next}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return
  }
  if (entry.mode !== undefined && (entry.mode & 0o170000) === 0o020000) {
    fs.charDevice?.(entry.path, entry.mode, entry.rdev ?? 0)
    applyMeta(fs, entry)
    return
  }
  try {
    const bytes = await held(limiter, () => vfs.read(entry.path))
    fs.writeFile(entry.path, bytes)
    applyMeta(fs, entry)
  } catch (err) {
    // The mount listed it, so it exists; we just cannot serve it. Say so
    // rather than leaving a hole the guest would read as absence and an
    // append would fill by replacing the file.
    fs.markUnreadable?.(entry.path)
    applyMeta(fs, entry)
    console.warn(
      `mirage preload: cannot read ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Copy one mount prefix into a synchronous target.
 *
 * The whole walk keeps at most `LISTING_ENTRY_CONCURRENCY` requests
 * in flight (listings, reads, readlinks), through one limiter shared
 * down the recursion, so a wide tree does not multiply the cap by its
 * breadth. An entry the door could not classify is stat'd once more
 * here: the
 * answer seeds it as usual, and a second failure seeds a node whose
 * stat and open both report it, never a guess at a file.
 *
 * Args:
 *   fs: the tree collector to fill.
 *   vfs: the runtime's mount vocabulary to read through.
 *   prefix: the mount prefix to walk.
 *   limiter: the walk's cap, created by the top-level call and passed
 *     down the recursion.
 */
export async function preloadInto(
  fs: FSLike,
  vfs: RuntimeVFS,
  prefix: string,
  limiter: ConcurrencyLimiter = new ConcurrencyLimiter(LISTING_ENTRY_CONCURRENCY),
): Promise<void> {
  const prefixWithSlash = prefix.endsWith('/') ? prefix : prefix + '/'
  const prefixWithoutSlash = prefixWithSlash.slice(0, -1)
  fs.mkdirTree(prefixWithoutSlash)
  const entries = await held(limiter, () => vfs.readdir(prefixWithSlash))
  await Promise.all(entries.map((entry) => preloadEntry(fs, vfs, entry, limiter)))
}
