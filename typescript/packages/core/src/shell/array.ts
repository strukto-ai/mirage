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

/** Append values after the highest assigned index, as `arr+=(...)`. */
export function arrayAppend(arr: ShellArray, values: string[]): void {
  arr.push(...values)
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
