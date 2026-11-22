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

import type { PosixEntry } from '../posix/types.ts'

/** One machine holding a name, and what it reports for it. */
export class Holder {
  /**
   * @param machine the machine's name under `machines:`.
   * @param entry the name's entry on that machine; null on a mount that
   *   shows one machine, which is not asked.
   */
  constructor(
    readonly machine: string,
    readonly entry: PosixEntry | null = null,
  ) {}

  /**
   * Whether the machine holds a directory at the name; false when it was
   * not asked.
   */
  get isFolder(): boolean {
    return this.entry?.kind === 'd'
  }

  /**
   * When the machine's copy was last written, in epoch milliseconds by its
   * own clock; 0 when it was not asked.
   */
  get writtenMs(): number {
    return this.entry?.mtimeMs ?? 0
  }
}
