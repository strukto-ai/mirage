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
 * A shell array: assigned values by index, with `null` for a hole left by
 * `unset arr[i]` or skipped by `arr[9]=v`. Holes are addressable but do
 * not count toward `${#arr[@]}` and do not expand in `${arr[@]}`.
 */
export type ShellArray = (string | null)[]

/** Build a dense array from consecutive values, starting at index 0. */
export function makeArray(values: string[]): ShellArray {
  return [...values]
}

/**
 * One past the highest assigned index, which is what bash resolves a
 * negative subscript against.
 */
export function arrayExtent(arr: ShellArray): number {
  return arr.length
}

/** The assigned values in index order, skipping holes. */
export function arrayValues(arr: ShellArray): string[] {
  return arr.filter((v): v is string => v !== null)
}

/** The assigned indices in order, skipping holes. */
export function arrayIndices(arr: ShellArray): number[] {
  const out: number[] = []
  arr.forEach((v, i) => {
    if (v !== null) out.push(i)
  })
  return out
}

/** The number of assigned elements, which is `${#arr[@]}`. */
export function arrayCount(arr: ShellArray): number {
  return arrayValues(arr).length
}

/** Whether `idx` holds an assigned element. */
export function arrayHas(arr: ShellArray, idx: number): boolean {
  return idx >= 0 && idx < arr.length && arr[idx] !== null && arr[idx] !== undefined
}

/**
 * The element at `idx`, or the empty string for a hole or an
 * out-of-range index.
 */
export function arrayGet(arr: ShellArray, idx: number): string {
  if (idx < 0 || idx >= arr.length) return ''
  return arr[idx] ?? ''
}

/**
 * Assign `value` at `idx`, extending with holes as needed.
 *
 * The subscript comes from script text, so the write goes through
 * `splice` rather than `arr[idx] = value`: an element assignment on a
 * caller-supplied key is a prototype-pollution shape, and `splice`
 * cannot name a property at all.
 */
export function arraySet(arr: ShellArray, idx: number, value: string): void {
  while (arr.length <= idx) arr.push(null)
  arr.splice(idx, 1, value)
}

/**
 * A copy of `arr` with `value` assigned at `idx`.
 *
 * What a writer hands the session plane's door: the door speaks in whole
 * variables, so an element write states itself as the array the write
 * produces. Building it on a copy is what keeps a refusal from leaving
 * the element applied.
 */
export function arrayWith(arr: ShellArray, idx: number, value: string): ShellArray {
  const updated = [...arr]
  arraySet(updated, idx, value)
  return updated
}

/**
 * Take the assigned elements from index `offset` on, in index order.
 *
 * bash slices an indexed array by *subscript*, not by position among the
 * assigned values: for `a=([1]=b [3]=d [9]=j)`, `${a[@]:2}` is `d j`
 * because it keeps every index >= 2. `length` then caps how many of those
 * are taken. A negative offset counts back from the extent and yields
 * nothing if it is still negative.
 */
export function arraySlice(arr: ShellArray, offset: number, length: number | null): string[] {
  let start = offset
  if (start < 0) {
    start += arrayExtent(arr)
    if (start < 0) return []
  }
  const picked: string[] = []
  arr.forEach((v, i) => {
    if (v !== null && i >= start) picked.push(v)
  })
  if (length === null) return picked
  if (length < 0) return picked.slice(0, Math.max(0, picked.length + length))
  return picked.slice(0, length)
}

/**
 * Clear one element, keeping the indices of the elements after it.
 *
 * Trailing holes are dropped so the extent stays at one past the highest
 * assigned index, matching how bash resolves `arr[-1]`.
 */
export function arrayUnset(arr: ShellArray, idx: number): void {
  if (idx < 0 || idx >= arr.length) return
  arr.splice(idx, 1, null)
  while (arr.length > 0 && arr[arr.length - 1] === null) arr.pop()
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
 * assign, and the assignment lands through the session door.
 */
export async function buildIndexedLiteral(
  base: ShellArray | null,
  words: readonly string[],
  append: boolean,
  indexOf: (subscript: string) => Promise<number>,
): Promise<ShellArray> {
  const arr: ShellArray = append && base !== null ? [...base] : []
  let cursor = append ? arrayExtent(arr) : 0
  for (const word of words) {
    const keyed = keyedWord(word)
    if (keyed !== null) {
      let idx = await indexOf(keyed[0])
      if (idx < 0) idx += arrayExtent(arr)
      if (idx < 0) continue
      arraySet(arr, idx, keyed[1])
      cursor = idx + 1
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
