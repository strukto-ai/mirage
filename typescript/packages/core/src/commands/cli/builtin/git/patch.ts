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

import { getOpcodes, groupOpcodes } from '../../../builtin/diff_format.ts'
import { DiffOpTag } from '../../../builtin/diff_types.ts'
import { decodeText, encodeText } from '../../../../shell/bytes.ts'
import { FUNCNAME_START, GIT_SPACE } from './constants.ts'
import { quotePath } from './render.ts'
import { readBlobBytes, type Repo } from './repo.ts'
import type { TreeEntry } from './tree.ts'

const HUNK_CONTEXT = 3
const FUNCNAME_BYTES = 80
const HUNK_HEADER_BYTES = 128
const BINARY_SNIFF = 8000
const OID_HEX = 40
const DEV_NULL = '/dev/null'

/** An entry's bytes: a blob's contents, a submodule's commit line, empty for a missing side. */
export async function blobData(repo: Repo, entry: TreeEntry | null): Promise<Uint8Array> {
  if (!entry) return new Uint8Array()
  if (entry.mode === '160000') return encodeText(`Subproject commit ${entry.oid}\n`)
  return readBlobBytes(repo, entry.oid)
}

/** A blob's lines, each keeping its newline, as xdiff splits them. */
export function lines(data: Uint8Array): string[] {
  const text = decodeText(data)
  return text === '' ? [] : text.split(/(?<=\n)/)
}

/** An entry's object id cut to `width`, zeros for a missing side. */
export function shortOid(entry: TreeEntry | null, width: number): string {
  return (entry?.oid ?? '0'.repeat(OID_HEX)).slice(0, width)
}

/**
 * One path's patch, headers and hunks, as git's builtin_diff writes it. A
 * change between a file and a symlink is split into a deletion and a creation,
 * the way git's run_diff splits a type change. A `---` or `+++` label holding a
 * space ends in a tab, so a patch tool can tell where the name stops.
 */
export async function filePatch(
  repo: Repo,
  path: string,
  oldPath: string,
  before: TreeEntry | null,
  after: TreeEntry | null,
  score: number | null,
  width: number,
  fully = true,
  count = HUNK_CONTEXT,
  functionContext = false,
  forceText = false,
): Promise<string> {
  if (before && after && before.mode.slice(0, 3) !== after.mode.slice(0, 3))
    return (
      (await filePatch(
        repo,
        path,
        oldPath,
        before,
        null,
        score,
        width,
        fully,
        count,
        functionContext,
        forceText,
      )) +
      (await filePatch(
        repo,
        path,
        oldPath,
        null,
        after,
        score,
        width,
        fully,
        count,
        functionContext,
        forceText,
      ))
    )
  const source = quotePath(`a/${oldPath}`, false, fully),
    target = quotePath(`b/${path}`, false, fully)
  const head = [`diff --git ${source} ${target}`]
  if (!before && after) head.push(`new file mode ${after.mode}`)
  else if (!after && before) head.push(`deleted file mode ${before.mode}`)
  else if (before && after && before.mode !== after.mode)
    head.push(`old mode ${before.mode}`, `new mode ${after.mode}`)
  if (score !== null)
    head.push(
      `similarity index ${String(score)}%`,
      `rename from ${quotePath(oldPath, false, fully)}`,
      `rename to ${quotePath(path, false, fully)}`,
    )
  if (before && before.oid === after?.oid) return text(head)
  head.push(
    `index ${shortOid(before, width)}..${shortOid(after, width)}` +
      (before && before.mode === after?.mode ? ` ${after.mode}` : ''),
  )
  const old = await blobData(repo, before),
    fresh = await blobData(repo, after)
  const from = before ? source : DEV_NULL,
    to = after ? target : DEV_NULL
  if (!forceText && [old, fresh].some((data) => data.subarray(0, BINARY_SNIFF).includes(0)))
    return text([...head, `Binary files ${from} and ${to} differ`])
  const body = hunks(lines(old), lines(fresh), count, functionContext)
  return (
    text(body ? [...head, `--- ${from}${labelTab(from)}`, `+++ ${to}${labelTab(to)}`] : head) + body
  )
}

/** The tab git puts after a `---`/`+++` label holding a space. */
function labelTab(label: string): string {
  return label.includes(' ') ? '\t' : ''
}

function text(rows: readonly string[]): string {
  return rows.map((row) => row + '\n').join('')
}

/**
 * The `@@` hunks of a two-way patch, as xdiff's xdl_emit_diff emits them. Each
 * header carries the nearest earlier line of the old side that starts with a
 * letter, `_` or `$` (git's default funcname), and keeps the previous hunk's
 * when none lies between the two.
 */
function hunks(
  old: readonly string[],
  fresh: readonly string[],
  count: number,
  functionContext = false,
): string {
  const out: string[] = []
  let context = ''
  let searched = -1
  const codes = getOpcodes(old, fresh)
  const groups = groupOpcodes(codes, count)
  for (const group of functionContext ? functionGroups(old, codes, groups) : groups) {
    const first = group[0],
      last = group.at(-1)
    if (first === undefined || last === undefined) continue
    const start = first[1]
    for (let k = start - 1; k > searched; k--) {
      const line = old[k] ?? ''
      if (FUNCNAME_START.test(line)) {
        context = trimmed(encodeText(line).subarray(0, FUNCNAME_BYTES))
        break
      }
    }
    searched = start - 1
    let header = `@@ -${span(start, last[2])} +${span(first[3], last[4])} @@`
    if (context) {
      const room = HUNK_HEADER_BYTES - encodeText(header).length - 2
      header += ' ' + decodeText(encodeText(context).subarray(0, room))
    }
    out.push(header + '\n')
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === DiffOpTag.EQUAL) {
        for (const line of old.slice(i1, i2)) out.push(hunkLine(' ', line))
        continue
      }
      for (const line of old.slice(i1, i2)) out.push(hunkLine('-', line))
      for (const line of fresh.slice(j1, j2)) out.push(hunkLine('+', line))
    }
  }
  return out.join('')
}

function trimmed(bytes: Uint8Array): string {
  let end = bytes.length
  while (end > 0 && GIT_SPACE.has(bytes[end - 1] ?? 0)) end--
  return decodeText(bytes.subarray(0, end))
}

function span(start: number, stop: number): string {
  if (stop - start === 1) return String(start + 1)
  return `${String(stop > start ? start + 1 : start)},${String(stop - start)}`
}

function hunkLine(marker: string, line: string): string {
  return line.endsWith('\n') ? marker + line : `${marker}${line}\n\\ No newline at end of file\n`
}

type Opcode = ReturnType<typeof getOpcodes>[number]

/** Widen to Git's default function boundaries (Git 2.47.3 Debian / 2.50.1). */
function functionGroups(
  old: readonly string[],
  codes: readonly Opcode[],
  groups: readonly Opcode[][],
): Opcode[][] {
  const boundaries = old.flatMap((line, i) => (FUNCNAME_START.test(line) ? [i] : []))
  const ranges: [number, number][] = []
  for (const group of groups) {
    const changes = group.filter((code) => code[0] !== DiffOpTag.EQUAL)
    const first = changes[0],
      last = changes.at(-1)
    if (!first || !last || !group[0] || !group.at(-1)) continue
    const start = Math.min(group[0][1], boundaries.filter((i) => i <= first[1]).at(-1) ?? 0)
    let end = boundaries.find((i) => i >= Math.max(last[2], last[1] + 1)) ?? old.length
    while (end < old.length && end > last[2] && !(old[end - 1] ?? '').trim()) end--
    end = Math.max(end, group.at(-1)?.[2] ?? end)
    const previous = ranges.at(-1)
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end)
    else ranges.push([start, end])
  }
  return ranges.map(([start, end]) =>
    codes.flatMap(([tag, i1, i2, j1, j2]): Opcode[] => {
      if (tag === DiffOpTag.EQUAL) {
        const lo = Math.max(start, i1),
          hi = Math.min(end, i2)
        return lo < hi ? [[tag, lo, hi, j1 + lo - i1, j1 + hi - i1]] : []
      }
      return i1 <= end && i2 >= start ? [[tag, i1, i2, j1, j2]] : []
    }),
  )
}
