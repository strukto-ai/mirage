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

import type { FSLike } from '../mirage_bridge.ts'

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
  readonly unreadable = new Set<string>()

  mkdirTree(path: string): void {
    this.dirs.push(path)
  }

  writeFile(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes)
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
}
