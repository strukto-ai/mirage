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

import { foldAscii } from '../../../../utils/posix.ts'
import { byteView, decodeText } from '../../../../shell/bytes.ts'

import { getOpcodes } from '../../../builtin/diff_format.ts'
import { DiffOpTag } from '../../../builtin/diff_types.ts'
import { PosixRegex } from '../../../../rs/regex.ts'
import { blobData, byteLines } from './patch.ts'
import type { Repo } from './repo.ts'
import { BINARY_SNIFF } from './summary.ts'
import type { TreeEntry } from './tree.ts'

/**
 * A `-S` or `-G` search, which git runs on every file pair a diff compares, once
 * renames are paired.
 */
export interface Pickaxe {
  /** `-S`'s string, or its pattern under `--pickaxe-regex`; null for `-G`. */
  readonly needle: string | PosixRegex | null
  /** `-G`'s pattern; null for `-S`. */
  readonly changed: PosixRegex | null
  /** `-i`, which folds a `-S` string's ASCII letters. */
  readonly ignoreCase: boolean
  /** `--text`: `-G` reads a binary side's lines too. */
  readonly forceText: boolean
  /** `--pickaxe-all`: one matching pair keeps every pair its comparison found. */
  readonly every: boolean
  /** The line's abort, which a long pattern search stops at. */
  readonly signal?: AbortSignal
}

/**
 * How many times a pattern matches a blob, git's `contains` under
 * `--pickaxe-regex` and glibc's REG_NEWLINE: a match stays in its line, each
 * search resumes where the last match ended (a step further after an empty
 * one), and `^` never holds where it resumes. mirage-rs counts the whole blob
 * in one request.
 */
export function contains(text: string, pattern: PosixRegex, signal?: AbortSignal): Promise<number> {
  return pattern.contains(text, signal)
}

/**
 * How many times a string appears in one side, or a pattern matches it as git
 * counts under `--pickaxe-regex`.
 */
async function occurrences(
  repo: Repo,
  entry: TreeEntry | null,
  needle: string | PosixRegex,
  ignoreCase: boolean,
  signal?: AbortSignal,
): Promise<number> {
  const data = await blobData(repo, entry)
  if (needle instanceof PosixRegex) return contains(byteView(data, needle.utf8), needle, signal)
  const text = ignoreCase ? foldAscii(decodeText(data)) : decodeText(data)
  if (needle === '') return 0
  let count = 0
  let at = text.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = text.indexOf(needle, at + needle.length)
  }
  return count
}

/**
 * Whether a pair's diff adds or removes a line the pattern matches: git's `-G`.
 * The lines are the ones `git log -p` prints with a `+` or `-`, from the same
 * line diff; a binary side is skipped, as git does without `--text`.
 */
async function greps(
  repo: Repo,
  oldEntry: TreeEntry | null,
  newEntry: TreeEntry | null,
  pattern: PosixRegex,
  forceText: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  const old = await blobData(repo, oldEntry)
  const now = await blobData(repo, newEntry)
  if (!forceText && [old, now].some((data) => data.subarray(0, BINARY_SNIFF).includes(0)))
    return false
  const before = byteLines(old)
  const after = byteLines(now)
  for (const [tag, i1, i2, j1, j2] of getOpcodes(before, after)) {
    if (tag === DiffOpTag.EQUAL) continue
    for (const line of [...before.slice(i1, i2), ...after.slice(j1, j2)]) {
      const text = byteView(line.endsWith('\n') ? line.slice(0, -1) : line, pattern.utf8)
      if ((await pattern.search(text, 0, signal)) !== null) return true
    }
  }
  return false
}

/**
 * Whether one file pair passes the pickaxe.
 *
 * `-S` is deliberately not a grep: a pair that merely moves a line holding the
 * string leaves its count alone, so it does not match, and the commit that
 * *introduced* the string does, which is what makes `-S <name> --reverse`
 * answer "where did this come from". A missing side holds nothing, so whatever
 * a new file adds counts as introduced, and each side reads the way `blobData`
 * reads it, so a gitlink is its `Subproject commit` line, as git's pickaxe sees
 * it. `-i` counts without regard to ASCII case; a `--pickaxe-regex` pattern
 * carries its own case folding.
 *
 * @param repo repository holding the blobs
 * @param pickaxe the search
 * @param old the old side, null when the path is new
 * @param now the new side, null when the path is gone
 */
export async function matches(
  repo: Repo,
  pickaxe: Pickaxe,
  old: TreeEntry | null,
  now: TreeEntry | null,
): Promise<boolean> {
  const { needle, ignoreCase, signal } = pickaxe
  if (pickaxe.changed !== null)
    return greps(repo, old, now, pickaxe.changed, pickaxe.forceText, signal)
  if (needle === null) return true
  const wanted = ignoreCase && typeof needle === 'string' ? foldAscii(needle) : needle
  return (
    (await occurrences(repo, old, wanted, ignoreCase, signal)) !==
    (await occurrences(repo, now, wanted, ignoreCase, signal))
  )
}
