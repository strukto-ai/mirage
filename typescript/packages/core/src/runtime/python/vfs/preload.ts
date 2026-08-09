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

import type { RuntimeVFS, VFSEntry } from '../../vfs.ts'

export interface FSLike {
  mkdirTree(path: string): void
  writeFile(path: string, bytes: Uint8Array): void
  /**
   * Note a listed file whose content could not be fetched. A target that
   * does not implement this simply omits the file, which is only safe
   * when nothing will write to it.
   */
  markUnreadable?(path: string): void
}

async function preloadEntry(fs: FSLike, vfs: RuntimeVFS, entry: VFSEntry): Promise<void> {
  // A namespace symlink is skipped, not followed: stat reports the
  // target, so a directory link would copy its whole subtree here and a
  // cyclic one would never terminate. The guest sees exactly what a
  // seed can hold, which has never included links.
  if (entry.isLink === true) return
  if (entry.isDir) {
    fs.mkdirTree(entry.path)
    const next = entry.path.endsWith('/') ? entry.path : entry.path + '/'
    try {
      await preloadInto(fs, vfs, next)
    } catch (err) {
      console.warn(
        `mirage preload: skipping subtree ${next}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return
  }
  try {
    const bytes = await vfs.read(entry.path)
    fs.writeFile(entry.path, bytes)
  } catch (err) {
    // The mount listed it, so it exists; we just cannot serve it. Say so
    // rather than leaving a hole the guest would read as absence and an
    // append would fill by replacing the file.
    fs.markUnreadable?.(entry.path)
    console.warn(
      `mirage preload: cannot read ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Copy one mount prefix into a synchronous target.
 *
 * Args:
 *   fs: the tree collector to fill.
 *   vfs: the runtime's mount vocabulary to read through.
 *   prefix: the mount prefix to walk.
 */
export async function preloadInto(fs: FSLike, vfs: RuntimeVFS, prefix: string): Promise<void> {
  const prefixWithSlash = prefix.endsWith('/') ? prefix : prefix + '/'
  const prefixWithoutSlash = prefixWithSlash.slice(0, -1)
  fs.mkdirTree(prefixWithoutSlash)
  const entries = await vfs.readdir(prefixWithSlash)
  await Promise.all(entries.map((entry) => preloadEntry(fs, vfs, entry)))
}
