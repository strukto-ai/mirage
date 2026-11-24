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

/**
 * Every machine's copy of a name some machine holds, and the copy every look
 * at it goes to. Mirrors Python's `Copies`.
 */
export class Copies {
  /**
   * @param held the machines holding the name, in the order `machines:`
   *   lists them.
   * @param shown the copy every look goes to (`chosen`).
   */
  constructor(
    readonly held: readonly Holder[],
    readonly shown: Holder,
  ) {}

  /** The machines holding the name. */
  get machines(): string[] {
    return this.held.map((one) => one.machine)
  }

  /** The machines holding the name as a folder. */
  get folders(): string[] {
    return this.held.filter((one) => one.isFolder).map((one) => one.machine)
  }

  /** The copies other than the one shown. */
  get others(): Holder[] {
    return this.held.filter((one) => one !== this.shown)
  }
}

/** Where a write lands on a mount's machines, and how. Mirrors Python's `Landing`. */
export class Landing {
  /**
   * @param machine the machine the bytes land on.
   * @param origin the bytes come from that machine (a program's `>`, a
   *   copy), so the write replaces the name across the machines: no other
   *   machine's copy of it stays.
   * @param makeParent the name's folder must be made there first, since only
   *   other machines hold it.
   */
  constructor(
    readonly machine: string,
    readonly origin = false,
    readonly makeParent = false,
  ) {}
}
