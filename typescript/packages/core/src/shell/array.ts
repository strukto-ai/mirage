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

/**
 * An indexed array, as bash keeps one: only its assigned elements, by
 * index, in index order. `a[1000000000]=x` holds one element, and an index
 * no write reached, or `unset` cleared, is no element at all: it does not
 * count toward `${#a[@]}` or expand in `${a[@]}`. Indices are bigints, so
 * one past 2^53 is as exact as bash's 64-bit one. Mirrors Python's
 * `ShellArray`.
 */
export class ShellArray {
  /** Index to value, in index order. */
  readonly elements: Map<bigint, string>
  private top = -1n

  constructor(elements: Iterable<readonly [number | bigint, string]> = []) {
    const entries = [...elements].map(([index, value]) => [BigInt(index), value] as const)
    this.elements = new Map(entries.sort(ShellArray.byIndex))
    for (const index of this.elements.keys()) this.top = index
  }

  /** One past the highest index assigned. */
  get extent(): bigint {
    return this.top + 1n
  }

  /** Assign `value` at `idx`, keeping the elements in index order. */
  set(idx: number | bigint, value: string): void {
    const at = BigInt(idx)
    const ordered = this.elements.has(at) || at > this.top
    this.elements.set(at, value)
    if (ordered) {
      if (at > this.top) this.top = at
      return
    }
    const sorted = [...this.elements].sort(ShellArray.byIndex)
    this.elements.clear()
    for (const [index, item] of sorted) this.elements.set(index, item)
  }

  /** Clear the element at `idx`, if it holds one. */
  unset(idx: number | bigint): void {
    const at = BigInt(idx)
    if (!this.elements.delete(at) || at !== this.top) return
    this.top = -1n
    for (const index of this.elements.keys()) this.top = index
  }

  /** A copy a write to which leaves this one as it is. */
  copy(): ShellArray {
    return new ShellArray(this.elements)
  }

  private static readonly byIndex = (
    [a]: readonly [bigint, string],
    [b]: readonly [bigint, string],
  ): number => (a < b ? -1 : a > b ? 1 : 0)
}

/** Build a dense array from consecutive values, starting at index 0. */
export function makeArray(values: readonly string[]): ShellArray {
  return new ShellArray(values.map((value, index) => [index, value] as const))
}

/**
 * One past the highest assigned index, which is what bash resolves a
 * negative subscript against.
 */
export function arrayExtent(arr: ShellArray): bigint {
  return arr.extent
}

/** The element at `idx`, or the empty string for an index that holds none. */
export function arrayGet(arr: ShellArray, idx: number | bigint): string {
  return arr.elements.get(BigInt(idx)) ?? ''
}

/** Assign `value` at `idx`, keeping the elements in index order. */
export function arraySet(arr: ShellArray, idx: number | bigint, value: string): void {
  arr.set(idx, value)
}

/**
 * A copy of `arr` with `value` assigned at `idx`.
 *
 * What a writer hands the session view: the session view speaks in whole
 * variables, so an element write states itself as the array the write
 * produces. Building it on a copy is what keeps a refusal from leaving
 * the element applied.
 */
export function arrayWith(arr: ShellArray, idx: number | bigint, value: string): ShellArray {
  const updated = arr.copy()
  updated.set(idx, value)
  return updated
}

/**
 * Clear one element, keeping the indices of the elements after it. The
 * extent stays at one past the highest assigned index, matching how bash
 * resolves `arr[-1]`.
 */
export function arrayUnset(arr: ShellArray, idx: number | bigint): void {
  arr.unset(idx)
}

/**
 * Split one `[key]=value` literal element, null for a plain word.
 *
 * The split lands on the first `]=`, which is where bash finds it after
 * quote removal; a key that itself holds `]=` needed quoting in bash too
 * and is the one spelling this cannot recover.
 */
export function keyedWord(word: string): [string, string] | null {
  if (!word.startsWith('[')) return null
  const pos = word.indexOf(']=', 1)
  if (pos <= 1) return null
  return [word.slice(1, pos), word.slice(pos + 2)]
}

/**
 * The indexed array a compound literal produces.
 *
 * A `[i]=v` element places at `i` and moves the cursor past it, a plain
 * word continues from the cursor, and a repeated index keeps the last
 * value, which is GNU's `([3]=x y [1]=z)` giving
 * `([1]="z" [3]="x" [4]="y")`. `+=` starts the cursor at the extent
 * instead of replacing. `indexOf` is async because a subscript may
 * assign, and the assignment lands through the session view.
 */
export async function buildIndexedLiteral(
  base: ShellArray | null,
  words: readonly string[],
  append: boolean,
  indexOf: (subscript: string) => Promise<number | bigint>,
): Promise<ShellArray> {
  const arr = append && base !== null ? base.copy() : new ShellArray()
  let cursor = append ? arrayExtent(arr) : 0n
  for (const word of words) {
    const keyed = keyedWord(word)
    if (keyed !== null) {
      let idx = BigInt(await indexOf(keyed[0]))
      if (idx < 0n) idx += arrayExtent(arr)
      if (idx < 0n) continue
      arraySet(arr, idx, keyed[1])
      cursor = idx + 1n
    } else {
      arraySet(arr, cursor, word)
      cursor++
    }
  }
  return arr
}

/**
 * The associative array a compound literal produces.
 *
 * The first word picks the grammar, as GNU does: a `[key]=value` first
 * word makes every plain word an error (reported back for the caller to
 * render in bash's must-use-subscript voice), while a plain first word
 * reads the whole list as alternating keys and values, `[a]=1`
 * spellings included, literally. An odd pair list stores the last key
 * with an empty value. A repeated key keeps the last value; `+=` merges
 * over the existing map instead of replacing.
 */
export function buildAssocLiteral(
  base: Readonly<Record<string, string>> | null,
  words: readonly string[],
  append: boolean,
): { map: Record<string, string>; badWords: string[] } {
  const map: Record<string, string> = append && base !== null ? { ...base } : {}
  const first = words[0]
  if (first === undefined) return { map, badWords: [] }
  if (keyedWord(first) === null) {
    for (let i = 0; i < words.length; i += 2) {
      const key = words[i]
      if (key === undefined) break
      map[key] = words[i + 1] ?? ''
    }
    return { map, badWords: [] }
  }
  const badWords: string[] = []
  for (const word of words) {
    const keyed = keyedWord(word)
    if (keyed === null) {
      badWords.push(word)
      continue
    }
    map[keyed[0]] = keyed[1]
  }
  return { map, badWords }
}
