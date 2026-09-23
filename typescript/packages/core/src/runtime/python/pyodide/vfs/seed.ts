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

import type { FSLike } from './preload.ts'

/**
 * A mount's tree, collected in memory so it can be served synchronously.
 *
 * `preloadInto` walks the bridge and writes through this interface; the
 * result seeds a `NodeTree` once its filesystem has mounted. The split
 * exists because fetching is async and every filesystem callback is not.
 */
export class MirageFsSeed implements FSLike {
  readonly dirs: string[] = []
  readonly files = new Map<string, Uint8Array>()
  readonly devices = new Map<string, { mode: number; rdev: number }>()
  readonly unreadable = new Set<string>()
  readonly unclassified = new Set<string>()
  readonly links = new Map<string, string>()
  readonly modes = new Map<string, number>()
  readonly stamps = new Map<string, { atimeMs: number; mtimeMs: number }>()

  mkdirTree(path: string): void {
    this.dirs.push(path)
  }

  writeFile(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes)
  }

  charDevice(path: string, mode: number, rdev: number): void {
    this.devices.set(path, { mode, rdev })
  }

  /**
   * Note a namespace symlink and what it points at.
   *
   * Args:
   *   path: guest-absolute path of the link.
   *   target: the stored target, verbatim as it was typed.
   */
  symlink(path: string, target: string): void {
    this.links.set(path, target)
  }

  /**
   * Note the mount's permission bits for a path.
   *
   * Recorded rather than applied: the node it belongs to does not exist
   * until `NodeTree.seed` places it.
   *
   * Args:
   *   path: guest-absolute path.
   *   mode: the mount's mode, type bits included.
   */
  chmod(path: string, mode: number): void {
    this.modes.set(path, mode)
  }

  /**
   * Note the mount's stamps for a path, in milliseconds.
   *
   * Args:
   *   path: guest-absolute path.
   *   atimeMs: access stamp.
   *   mtimeMs: modification stamp.
   */
  utime(path: string, atimeMs: number, mtimeMs: number): void {
    this.stamps.set(path, { atimeMs, mtimeMs })
  }

  /**
   * Note a file the mount listed but would not hand over.
   *
   * Leaving it out of the tree entirely would be unsafe: the guest would
   * see no file, and `open(path, 'a')` would build its buffer from empty
   * and replace content this run never read. A node that refuses to open
   * says the same thing without risking the file.
   *
   * Args:
   *   path: guest-absolute path that could not be fetched.
   */
  markUnreadable(path: string): void {
    this.unreadable.add(path)
  }

  /**
   * Note an entry the mount listed but would not stat, asked twice.
   *
   * Seeded as a node that answers neither a stat nor an open: its kind,
   * size and content are all unknown, and inventing any of them would
   * hand the guest a file the mount never described.
   *
   * Args:
   *   path: guest-absolute path that could not be classified.
   */
  markUnclassified(path: string): void {
    this.unclassified.add(path)
  }
}
