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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { IOResult } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { lstripSlash, stripSlash } from '../../../utils/slash.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName, type FlagValue } from '../../spec/types.ts'
import { READ_FAILURES } from '../../../errors/constants.ts'
import { fsStrerror, isEisdir, isEnoent, isFsError } from '../../../errors/fs.ts'
import { shellQuote } from '../../../utils/quote.ts'
import { splitLines } from '../utils/lines.ts'
import { mountRoot } from '../utils/links.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

// A patch name with `-p` leading components dropped, GNU's way: a run of
// slashes is one separator, and a name with fewer components than `-p`
// drops leaves no name at all. Mirrors Python's _strip_name.
function stripName(name: string, stripCount: number): string | null {
  let rest = name
  for (let i = 0; i < stripCount; i++) {
    const cut = rest.indexOf('/')
    if (cut < 0) return null
    rest = lstripSlash(rest.slice(cut))
  }
  return rest
}

// A `---`/`+++` line's name, and what a reject file says for it: the file
// as `-p` leaves it (`/dev/null` when it leaves nothing) and the timestamp
// the header carried. Mirrors Python's _label.
function label(line: string, stripCount: number): [string, string] {
  const rest = line.slice(4)
  const tab = rest.indexOf('\t')
  const name = (tab < 0 ? rest : rest.slice(0, tab)).trim()
  const stamp = tab < 0 ? '' : rest.slice(tab)
  const stripped = name === '/dev/null' ? null : stripName(name, stripCount)
  return [name, (stripped ?? '/dev/null') + stamp]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
// The fuzz factor the manual gives as patch's default: a hunk may leave up
// to this many of its outer context lines unmatched to be placed.
const FUZZ_FACTOR = 2

function span(start: number, count: number): string {
  return count === 1 ? String(start) : `${String(start)},${String(count)}`
}

// One `@@` hunk: where its header says each side starts, what the header
// carries after the closing `@@`, and its lines, each led by ' ', '-' or
// '+'. Mirrors Python's _Hunk.
interface Hunk {
  readonly oldStart: number
  readonly newStart: number
  readonly note: string
  readonly body: readonly string[]
}

function swapped(hunk: Hunk): Hunk {
  const flip: Record<string, string> = { '-': '+', '+': '-' }
  return {
    oldStart: hunk.newStart,
    newStart: hunk.oldStart,
    note: hunk.note,
    body: hunk.body.map((line) => (flip[line.slice(0, 1)] ?? line.slice(0, 1)) + line.slice(1)),
  }
}

// Its old and new sides' line counts.
function sizesOf(hunk: Hunk): [number, number] {
  const old = hunk.body.filter((line) => !line.startsWith('+')).length
  const added = hunk.body.filter((line) => !line.startsWith('-')).length
  return [old, added]
}

// Its lines in a reject file, as GNU writes a hunk back: the `@@` line
// moved by `grown` (the lines the hunks placed before it added), and each
// run of changes listing its removed lines before its added ones.
function rejectedLines(hunk: Hunk, grown: number): string[] {
  const [old, added] = sizesOf(hunk)
  const lines = [
    `@@ -${span(hunk.oldStart + grown, old)} +${span(hunk.newStart + grown, added)} @@${hunk.note}`,
  ]
  let pending: string[] = []
  for (const line of hunk.body) {
    if (line.startsWith('+')) {
      pending.push(line)
      continue
    }
    if (line.startsWith(' ')) {
      for (const item of pending) lines.push(item)
      pending = []
    }
    lines.push(line)
  }
  return [...lines, ...pending]
}

// One file's part of a patch: what its reject file's `---` and `+++` lines
// say, the file it patches by its headers (`-p` applied), and its hunks in
// order. Mirrors Python's _Section.
interface Section {
  readonly oldLabel: string
  readonly newLabel: string
  readonly target: string
  readonly hunks: readonly Hunk[]
}

// The hunks that start at `lines[index]`, and the index after them. A hunk
// ends when its header's line counts are used up, as GNU reads it, so a
// removed line that reads `-- x` is never taken for the next file's header.
// Mirrors Python's _parse_hunks.
function parseHunks(lines: readonly string[], start: number): [Hunk[], number] {
  const hunks: Hunk[] = []
  let index = start
  while (index < lines.length) {
    const header = lines[index] ?? ''
    const match = HUNK_HEADER.exec(header)
    if (match === null) break
    let oldLeft = match[2] === undefined ? 1 : Number.parseInt(match[2], 10)
    let newLeft = match[4] === undefined ? 1 : Number.parseInt(match[4], 10)
    const body: string[] = []
    index += 1
    while (index < lines.length && (oldLeft > 0 || newLeft > 0)) {
      const line = lines[index] ?? ''
      const kind = line.slice(0, 1)
      if (kind === ' ' || kind === '') {
        oldLeft -= 1
        newLeft -= 1
        body.push(' ' + line.slice(1))
      } else if (kind === '-') {
        oldLeft -= 1
        body.push(line)
      } else if (kind === '+') {
        newLeft -= 1
        body.push(line)
      } else if (kind !== '\\') {
        break
      }
      index += 1
    }
    while (index < lines.length && (lines[index] ?? '').startsWith('\\')) index += 1
    hunks.push({
      oldStart: Number.parseInt(match[1] ?? '0', 10),
      newStart: Number.parseInt(match[3] ?? '0', 10),
      note: header.slice(match[0].length),
      body,
    })
  }
  return [hunks, index]
}

// The patch's file sections in the order it gives them. Two sections may
// name one file, and each is applied in turn, as GNU does. Mirrors Python's
// _parse_patch.
function parsePatch(patchText: string, stripCount: number): Section[] {
  const sections: Section[] = []
  const lines = splitLines(patchText)
  let oldLabel = '/dev/null'
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    index += 1
    if (line.startsWith('--- ')) {
      oldLabel = label(line, stripCount)[1]
      continue
    }
    if (!line.startsWith('+++ ')) continue
    const [newName, newLabel] = label(line, stripCount)
    const [hunks, next] = parseHunks(lines, index)
    index = next
    const target = stripName(newName, stripCount) ?? newName.slice(newName.lastIndexOf('/') + 1)
    sections.push({ oldLabel, newLabel, target: '/' + lstripSlash(target), hunks })
    oldLabel = '/dev/null'
  }
  return sections
}

// What a hunk looks for in the file: its old side (context and removed
// lines), the context lines before its first change and after its last, and
// the line its header says the old side starts at. An empty old side
// (`-3,0`) goes in after the line it names, so it claims the line after
// that. Mirrors Python's _Needle.
interface Needle {
  readonly old: readonly string[]
  readonly lead: number
  readonly trail: number
  readonly claimed: number
}

export function needleOf(hunk: Hunk): Needle {
  const kinds = hunk.body.map((line) => line.slice(0, 1))
  let lead = 0
  while (lead < kinds.length && kinds[lead] === ' ') lead += 1
  let trail = 0
  while (trail < kinds.length - lead && kinds[kinds.length - 1 - trail] === ' ') trail += 1
  const old = hunk.body.filter((line) => !line.startsWith('+')).map((line) => line.slice(1))
  return { old, lead, trail, claimed: hunk.oldStart + (old.length > 0 ? 0 : 1) }
}

// The context lines still compared above and below at `fuzz`. Fuzz is spent
// on the longer end first: a hunk with three lines of context above its
// change and one below compares (3, 1) at fuzz 0, (2, 1) at fuzz 1 and
// (1, 1) at fuzz 2 (GNU patch 2.8). Mirrors Python's _compared_at.
function comparedAt(needle: Needle, fuzz: number): [number, number] {
  const most = Math.max(needle.lead, needle.trail) - fuzz
  return [Math.max(0, Math.min(needle.lead, most)), Math.max(0, Math.min(needle.trail, most))]
}

// Whether the hunk's old side, starting at 0-based line `at`, is there,
// reading only the context `compared` keeps. Lines left out above may hang
// off the top of the file, but nothing may run past its end except what is
// left out below. A hunk with less context at one end than at the other was
// cut short by that end of the file, so while that still holds it must meet
// it: a short bottom ends on the file's last line, and a short top whose
// header names line 1 starts on the first. Such a hunk is not found at all,
// rather than found out of order, where it would reach back into what
// earlier hunks used up: one meeting the end must start at or after `used`,
// and one meeting the start must make its first change at or after it (GNU
// patch 2.8).
// Mirrors Python's _sits.
function sits(
  lines: readonly string[],
  needle: Needle,
  at: number,
  compared: readonly [number, number],
  used: number,
): boolean {
  const [above, below] = compared
  const top = needle.lead - above
  const stop = needle.old.length - needle.trail + below
  if (at + stop > lines.length || (top < stop && at + top < 0)) return false
  if (above > below && (at + needle.old.length !== lines.length || at < used)) return false
  if (above < below && needle.claimed <= 1 && (at !== 0 || needle.lead < used)) return false
  for (let index = top; index < stop; index++) {
    if (lines[at + index] !== needle.old[index]) return false
  }
  return true
}

// The lines a hunk is tried at, in the order GNU patch 2.8 tries them. From
// an expected line at or past `used` (the lines the hunks placed before it
// used up) the search fans out: the expected line, one line later, one
// earlier, two later and so on, so at equal distance the later line wins,
// and it goes no higher than `used`. From an expected line above `used` it
// reaches as far above the expected line as `used` is below it, and tries
// that farthest line first, then `used`, then the lines between them in file
// order, then the lines after `used`: with 20 lines used and a hunk expected
// at line 15 it tries 9, 21, 10, 11, ..., 20, 22, ... (1-based). There, a
// hunk expected past the last line it fits at (`last`) is not tried
// anywhere. Mirrors Python's _tries.
export function* tries(expected: number, used: number, last: number): Generator<number> {
  if (expected < used) {
    if (expected > last) return
    const farthest = 2 * expected - used
    yield farthest
    yield used
    for (let at = farthest + 1; at < Math.min(used, last + 1); at++) yield at
    for (let at = used + 1; at <= last; at++) yield at
    return
  }
  yield expected
  for (let step = 1; expected + step <= last || expected - step >= used; step++) {
    if (expected + step <= last) yield expected + step
    if (expected - step >= used) yield expected - step
  }
}

// Whether `tries` ever reaches line `at`. Mirrors Python's _is_tried.
export function isTried(at: number, expected: number, used: number, last: number): boolean {
  if (expected < used) {
    if (expected > last) return false
    const farthest = 2 * expected - used
    return (
      at === farthest ||
      at === used ||
      (farthest < at && at < Math.min(used, last + 1)) ||
      (used < at && at <= last)
    )
  }
  return at === expected || (expected < at && at <= last) || (used <= at && at < expected)
}

// The one line a hunk held to an end of the file can start at, or null when
// the hunk is free to sit anywhere; see `sits` for when it is held. Mirrors
// Python's _forced_edge.
function forcedEdge(
  lines: readonly string[],
  needle: Needle,
  compared: readonly [number, number],
): number | null {
  const [above, below] = compared
  if (above > below) return lines.length - needle.old.length
  if (above < below && needle.claimed <= 1) return 0
  return null
}

// The 0-based line the hunk is found at with `fuzz`, or null. A hunk with no
// old side is not looked for: it goes where it is expected. One held to an
// end of the file is tried at that one line, if the search would reach it,
// instead of at every line the search tries. One that lands on the line
// before the first, line 0, is taken as not found at all, though one landing
// higher still is found there (GNU patch 2.8: `-0,0` expected one line up
// fails plainly, expected two lines up it fails as misordered). Mirrors
// Python's _seek.
export function seek(
  lines: readonly string[],
  needle: Needle,
  fuzz: number,
  expected: number,
  used: number,
): number | null {
  let found: number | null = expected
  if (needle.old.length > 0) {
    found = null
    const compared = comparedAt(needle, fuzz)
    const last = lines.length - (needle.old.length - needle.trail + compared[1])
    const edge = forcedEdge(lines, needle, compared)
    if (edge !== null) {
      if (isTried(edge, expected, used, last) && sits(lines, needle, edge, compared, used)) {
        found = edge
      }
    } else {
      for (const at of tries(expected, used, last)) {
        if (sits(lines, needle, at, compared, used)) {
          found = at
          break
        }
      }
    }
  }
  return found === -1 ? null : found
}

// The fuzz levels worth trying, each one comparing less than the last.
// Mirrors Python's _fuzz_steps.
function* fuzzSteps(needle: Needle): Generator<number> {
  let seen: readonly [number, number] | null = null
  for (let fuzz = 0; fuzz <= FUZZ_FACTOR; fuzz++) {
    const compared = comparedAt(needle, fuzz)
    if (compared[0] !== seen?.[0] || compared[1] !== seen[1]) {
      seen = compared
      yield fuzz
    }
  }
}

// Write the hunk's changes, placed at 0-based line `at`, onto `out`, and
// return the line after the last one it changed. Only the part from its
// first change to its last is written: the context around it stays in the
// file, where a later hunk may still read it, and context between changes is
// copied from the file rather than from the patch. Mirrors Python's _emit.
function emit(
  lines: readonly string[],
  hunk: Hunk,
  needle: Needle,
  at: number,
  out: string[],
): number {
  let source = at + needle.lead
  for (const line of hunk.body.slice(needle.lead, hunk.body.length - needle.trail)) {
    const kind = line.slice(0, 1)
    if (kind === '+') {
      out.push(line.slice(1))
      continue
    }
    if (kind === ' ') out.push(lines[source] ?? '')
    source += 1
  }
  return source
}

function placedNote(ordinal: number, line: number, fuzz: number, moved: number): string {
  let text = `Hunk #${String(ordinal)} succeeded at ${String(line)}`
  if (fuzz > 0) text += ` with fuzz ${String(fuzz)}`
  if (moved !== 0) text += ` (offset ${String(moved)} line${moved === 1 ? '' : 's'})`
  return `${text}.`
}

// A hunk for the reject file as it was tried (`-R` swaps it), with the
// lines the hunks placed before it added.
type Rejected = readonly [Hunk, number]

// What applying one section did: the patched lines (null when skipped), the
// lines GNU prints after `patching file`, the hunks for the reject file, and
// whether every hunk applied where it said with no fuzz. Mirrors Python's
// _Outcome.
interface Outcome {
  readonly lines: string[] | null
  readonly notes: string[]
  readonly rejected: Rejected[]
  readonly exact: boolean
}

// GNU's lines for a patch that reads as the other direction. Standard input
// is never a terminal here, so every question is answered with its default
// and the file is skipped. Mirrors Python's _reversed_notes.
function reversedNotes(reverse: boolean, forward: boolean): string[] {
  const seen = reverse
    ? 'Unreversed patch detected!'
    : 'Reversed (or previously applied) patch detected!'
  if (forward) return [`${seen}  Skipping patch.`]
  const ask = reverse ? 'Ignore' : 'Assume'
  return [`${seen}  ${ask} -R? [n] `, 'Apply anyway? [n] ', 'Skipping patch.']
}

function asTried(hunks: readonly Hunk[], reverse: boolean): Rejected[] {
  return hunks.map((hunk) => [reverse ? swapped(hunk) : hunk, 0] as const)
}

// Apply one section's hunks to a file's lines, as GNU patch does. Each hunk
// is looked for where its header and the hunks before it point, at fuzz 0
// and then with more of its outer context left out; one found nowhere is
// rejected. A hunk found where its change would land on lines an earlier hunk
// already changed is rejected too, and no further fuzz is tried for it. When
// the first hunk is not found but reads at that same fuzz the other way
// round, the file is skipped as already applied (or reversed). Lines are
// reported in the patched file's numbering. Mirrors Python's _apply_section.
function applySection(
  lines: readonly string[],
  hunks: readonly Hunk[],
  reverse: boolean,
  forward: boolean,
): Outcome {
  const out: string[] = []
  const notes: string[] = []
  const rejected: Rejected[] = []
  let exact = true
  let used = 0
  let shift = 0
  let grown = 0
  for (const [index, given] of hunks.entries()) {
    const ordinal = index + 1
    const hunk = reverse ? swapped(given) : given
    const want = needleOf(hunk)
    const other = ordinal === 1 ? needleOf(swapped(hunk)) : null
    const expected = want.claimed - 1 + shift
    let at: number | null = null
    let fuzz = 0
    for (fuzz of fuzzSteps(want)) {
      at = seek(lines, want, fuzz, expected, used)
      if (at !== null) break
      if (other !== null && seek(lines, other, fuzz, other.claimed - 1, 0) !== null) {
        return {
          lines: null,
          notes: reversedNotes(reverse, forward),
          rejected: asTried(hunks, reverse),
          exact: false,
        }
      }
    }
    if (at === null || at + want.lead < used) {
      let line = want.claimed
      if (at !== null) {
        notes.push('misordered hunks! output would be garbled')
        line = at + 1
        shift = at + 1 - want.claimed
      }
      notes.push(`Hunk #${String(ordinal)} FAILED at ${String(line + grown)}.`)
      rejected.push([hunk, grown])
      exact = false
      continue
    }
    shift = at + 1 - want.claimed
    if (fuzz > 0 || shift !== 0) {
      notes.push(placedNote(ordinal, at + 1 + grown, fuzz, shift))
      exact = false
    }
    for (const item of lines.slice(used, at + want.lead)) out.push(item)
    used = emit(lines, hunk, want, at, out)
    const [old, added] = sizesOf(hunk)
    grown += added - old
  }
  for (const item of lines.slice(used)) out.push(item)
  return { lines: out, notes, rejected, exact }
}

// GNU's reject file: the section's names (`-R` swaps them as it did the
// hunks), then each hunk as it was tried. Mirrors Python's _reject_text.
function rejectText(section: Section, rejected: readonly Rejected[], reverse: boolean): Uint8Array {
  const [first, second] = reverse
    ? [section.newLabel, section.oldLabel]
    : [section.oldLabel, section.newLabel]
  const lines = [`--- ${first}`, `+++ ${second}`]
  for (const [hunk, grown] of rejected) lines.push(...rejectedLines(hunk, grown))
  return ENC.encode(lines.map((line) => `${line}\n`).join(''))
}

function companion(spec: PathSpec, suffix: string): PathSpec {
  return PathSpec.fromStrPath(spec.virtual + suffix, spec.vfsPath + suffix)
}

// Where one section's report and bytes go: the lines printed so far, the
// files this run has written, and each file's `.rej` text so far.
interface PatchSink {
  readonly report: string[]
  readonly written: Set<string>
  readonly rejects: Map<string, Uint8Array>
  readonly write: (p: PathSpec, data: Uint8Array) => Promise<void>
}

// Write the hunks that did not go in to `.rej`, and say so. A file patched by
// several sections of one patch keeps one `.rej`: each section's rejects
// follow the last, under their own names. Mirrors Python's _save_rejects.
async function saveRejects(
  section: Section,
  rejected: readonly Rejected[],
  verb: string,
  spec: PathSpec,
  shown: string,
  reverse: boolean,
  sink: PatchSink,
): Promise<void> {
  const total = section.hunks.length
  sink.report.push(
    `${String(rejected.length)} out of ${String(total)} hunk${total === 1 ? '' : 's'} ${verb} -- saving rejects to file ${shown}.rej`,
  )
  const reject = companion(spec, '.rej')
  const earlier = sink.rejects.get(reject.virtual) ?? new Uint8Array()
  const added = rejectText(section, rejected, reverse)
  const data = new Uint8Array(earlier.length + added.length)
  data.set(earlier)
  data.set(added, earlier.length)
  sink.rejects.set(reject.virtual, data)
  await sink.write(reject, data)
}

// Apply one section to its file, GNU patch's way; true when a hunk of it was
// refused. A file that does not match the patch exactly is backed up to
// `.orig` the first time this run writes it, and the hunks that did not go
// in are saved to `.rej`, after those an earlier section of this run saved
// for it. A file that is not there is not made unless a hunk applied, and a
// directory is refused whole. Mirrors Python's _patch_file.
async function patchFile(
  section: Section,
  spec: PathSpec,
  shown: string,
  reverse: boolean,
  forward: boolean,
  read: (p: PathSpec) => Promise<Uint8Array>,
  sink: PatchSink,
): Promise<boolean> {
  let original: Uint8Array | null = null
  try {
    original = await read(spec)
  } catch (err) {
    if (isEisdir(err)) {
      sink.report.push(`File ${shown} is not a regular file -- refusing to patch`)
      await saveRejects(
        section,
        asTried(section.hunks, reverse),
        'ignored',
        spec,
        shown,
        reverse,
        sink,
      )
      return true
    }
    if (!isEnoent(err)) throw err
  }
  sink.report.push(`patching file ${shown}`)
  const outcome = applySection(
    splitLines(original === null ? '' : DEC.decode(original)),
    section.hunks,
    reverse,
    forward,
  )
  for (const item of outcome.notes) sink.report.push(item)
  if (outcome.lines !== null) {
    if (!outcome.exact && !sink.written.has(spec.virtual)) {
      if (original === null) {
        sink.report.push(`Cannot stat file ${shown}, skipping backup`)
      } else {
        const backup = companion(spec, '.orig')
        await sink.write(backup, original)
      }
    }
    if (original !== null || outcome.rejected.length < section.hunks.length) {
      const data = ENC.encode(outcome.lines.map((line) => `${line}\n`).join(''))
      await sink.write(spec, data)
      sink.written.add(spec.virtual)
    }
  }
  if (outcome.rejected.length === 0) return false
  await saveRejects(
    section,
    outcome.rejected,
    outcome.lines === null ? 'ignored' : 'FAILED',
    spec,
    shown,
    reverse,
    sink,
  )
  return true
}

/**
 * The patch text, or GNU's fatal line when it cannot be had. GNU opens the
 * patch file before anything else and gives up on the whole run when it
 * cannot (exit 2): an open that fails names the file (`Can't open patch file
 * x : ...`), a read that fails does not (`read error : ...`), since only one
 * patch file is ever read. Mirrors Python's _load_patch_data.
 */
async function loadPatchData(
  source: PathSpec | null,
  ctx: Context,
  read: (p: PathSpec) => Promise<Uint8Array>,
): Promise<Uint8Array | string | null> {
  if (source === null) return readStdinAsync(ctx.stdin)
  try {
    return await read(source)
  } catch (err) {
    if (!isFsError(err)) throw err
    const code = (err as { code?: string }).code
    if (code !== undefined && READ_FAILURES.has(code)) {
      return `patch: **** read error : ${String(fsStrerror(err))}\n`
    }
    return `patch: **** Can't open patch file ${shellQuote(source.rawPath)} : ${String(fsStrerror(err))}\n`
  }
}

// A -p value is one optional sign, then digits to the end of the word:
// GNU patch 2.8 refuses `3x` and ` 1`, and takes `+0`.
const STRIP_COUNT = /^[+-]?[0-9]+$/

// `-p` as GNU patch scans it, null for no number. Mirrors Python's
// `_strip_count`.
function stripCount(text: string): bigint | null {
  return STRIP_COUNT.test(text) ? BigInt(text) : null
}

// GNU patch's fatal line for a -p value that is no number or negative.
// Mirrors Python's `_strip_refusal`.
function stripRefusal(text: string, value: bigint | null): string {
  const problem = value === null ? 'is not a number' : 'is negative'
  return `patch: **** strip count ${shellQuote(text)} ${problem}`
}

interface PatchFlags {
  readonly strip: number
  readonly reverse: boolean
  // -i as the parser classified it: a path keeps its typed spelling.
  readonly inputPath: PathSpec | string | null
  readonly forward: boolean
}

function parseFlags(bag: Record<string, FlagValue>): PatchFlags {
  const fl = new FlagView(bag, specOf('patch'))
  const input = fl.raw('i')
  return {
    strip: Number(fl.asNumber('p', stripCount, stripRefusal, { low: 0n, exitCode: 2 }) ?? 0n),
    reverse: fl.asBool('R'),
    inputPath: input instanceof PathSpec ? input : (fl.asStr('i') ?? null),
    forward: fl.asBool('N'),
  }
}

export async function patchGeneric(
  paths: PathSpec[],
  ctx: Context,
  read: (p: PathSpec) => Promise<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<CommandFnResult> {
  const parsed = parseFlags(ctx.flags)
  if (paths.length > 2) throw extraOperandError(CommandName.PATCH, paths[2]?.rawPath ?? '')
  const { strip: stripCount, reverse: reverseMode, forward: forwardOnly, inputPath } = parsed
  const mountPrefix = mountRoot(ctx)
  // `patch [ORIGFILE [PATCHFILE]]`: the second operand is the patch file,
  // ahead of -i, and the first is the one file every hunk goes to in place
  // of the names the patch's headers carry. A `-i` classified as a path
  // keeps its typed spelling, which the fatal line names. Mirrors Python's
  // patch.
  const source =
    paths[1] ??
    (inputPath instanceof PathSpec
      ? inputPath
      : inputPath !== null
        ? PathSpec.fromStrPath(inputPath, mountKey(inputPath, mountPrefix))
        : null)
  const loaded = await loadPatchData(source, ctx, read)
  if (typeof loaded === 'string') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(loaded) })]
  }
  if (loaded === null || loaded.byteLength === 0) {
    return [null, new IOResult()]
  }

  const sections = parsePatch(DEC.decode(loaded), stripCount)
  const orig = paths[0] ?? null
  const sink: PatchSink = {
    report: [],
    written: new Set<string>(),
    rejects: new Map<string, Uint8Array>(),
    write,
  }
  let failed = false
  for (const section of sections) {
    const spec =
      orig ??
      PathSpec.fromStrPath(
        `${mountPrefix.replace(/\/$/, '')}/${lstripSlash(section.target)}`,
        stripSlash(section.target),
      )
    const shown = orig !== null ? orig.rawPath : lstripSlash(section.target)
    const refused = await patchFile(section, spec, shown, reverseMode, forwardOnly, read, sink)
    failed = failed || refused
  }
  const out = sink.report.length > 0 ? ENC.encode(sink.report.map((l) => `${l}\n`).join('')) : null
  return [out, new IOResult({ exitCode: failed ? 1 : 0 })]
}
