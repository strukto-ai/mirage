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
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { lstripSlash, stripSlash } from '../../../utils/slash.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName, type FlagValue } from '../../spec/types.ts'
import { READ_FAILURES } from '../../../errors/constants.ts'
import { fsStrerror, isEisdir, isEnoent, isFsError } from '../../../errors/fs.ts'
import { shellQuote } from '../../../utils/quote.ts'
import { splitLines } from '../utils/lines.ts'

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
function labelOf(line: string, stripCount: number): [string, string] {
  const rest = line.slice(4)
  const tab = rest.indexOf('\t')
  const name = (tab < 0 ? rest : rest.slice(0, tab)).trim()
  const stamp = tab < 0 ? '' : rest.slice(tab)
  const stripped = name === '/dev/null' ? null : stripName(name, stripCount)
  return [name, (stripped ?? '/dev/null') + stamp]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
// GNU patch's default fuzz factor: how many context lines at each end of a
// hunk may be ignored to place it.
const MAX_FUZZ = 2

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

function patternOf(hunk: Hunk): string[] {
  return hunk.body.filter((line) => !line.startsWith('+')).map((line) => line.slice(1))
}

// Its old and new sides' line counts.
function sizesOf(hunk: Hunk): [number, number] {
  const old = hunk.body.filter((line) => !line.startsWith('+')).length
  const added = hunk.body.filter((line) => !line.startsWith('-')).length
  return [old, added]
}

// The line its old side starts at, GNU's `pch_first`: an empty old side
// (`-3,0`) goes in after the line it names.
function firstOf(hunk: Hunk): number {
  return hunk.oldStart + (patternOf(hunk).length > 0 ? 0 : 1)
}

// The context lines before a hunk's first change and after its last.
function contextOf(hunk: Hunk): [number, number] {
  const kinds = hunk.body.map((line) => line.slice(0, 1))
  const prefix = kinds.findIndex((k) => k !== ' ')
  const suffix = [...kinds].reverse().findIndex((k) => k !== ' ')
  return [prefix === -1 ? kinds.length : prefix, suffix === -1 ? kinds.length : suffix]
}

// Its lines in a reject file, as GNU writes a hunk back: the `@@` line
// moved by the output offset (the lines the hunks applied before it
// added), and each run of changes listing its removed lines before its
// added ones.
function rejectedLines(hunk: Hunk, outOffset: number): string[] {
  const [old, added] = sizesOf(hunk)
  const lines = [
    `@@ -${span(hunk.oldStart + outOffset, old)} +${span(hunk.newStart + outOffset, added)} @@${hunk.note}`,
  ]
  let pending: string[] = []
  for (const line of hunk.body) {
    if (line.startsWith('+')) {
      pending.push(line)
      continue
    }
    if (line.startsWith(' ')) {
      lines.push(...pending)
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
      oldLabel = labelOf(line, stripCount)[1]
      continue
    }
    if (!line.startsWith('+++ ')) continue
    const [newName, newLabel] = labelOf(line, stripCount)
    const [hunks, next] = parseHunks(lines, index)
    index = next
    const target = stripName(newName, stripCount) ?? newName.slice(newName.lastIndexOf('/') + 1)
    sections.push({ oldLabel, newLabel, target: '/' + lstripSlash(target), hunks })
    oldLabel = '/dev/null'
  }
  return sections
}

function matches(
  lines: readonly string[],
  pattern: readonly string[],
  where: number,
  prefixFuzz: number,
  suffixFuzz: number,
): boolean {
  for (let k = prefixFuzz; k < pattern.length - suffixFuzz; k++) {
    const lineNo = where + k
    if (lineNo < 1 || lineNo > lines.length || lines[lineNo - 1] !== pattern[k]) return false
  }
  return true
}

// Where a hunk's old side is in `lines`, GNU's `locate_hunk`: the claimed
// line first, then alternately after and before it. With fuzz, that many
// context lines at each end go unchecked; a hunk with less context at one
// end is anchored there (a hunk that starts at the top of the file with no
// leading context can only match the top, one with no trailing context only
// the end). Mirrors Python's _locate.
function locate(
  lines: readonly string[],
  hunk: Hunk,
  inOffset: number,
  fuzz: number,
  frozen: number,
): number | null {
  const first = firstOf(hunk) + inOffset
  const pattern = patternOf(hunk)
  if (pattern.length === 0) return first
  const [prefix, suffix] = contextOf(hunk)
  const context = Math.max(prefix, suffix)
  let prefixFuzz = fuzz + prefix - context
  const suffixFuzz = fuzz + suffix - context
  const maxPos = lines.length - (pattern.length - suffixFuzz) + 1 - first
  const maxNeg = Math.min(first - (frozen + 1 - (prefix - prefixFuzz)), first - 1)
  if (prefixFuzz < 0) {
    if (firstOf(hunk) > 1) {
      prefixFuzz = 0
    } else {
      const atTop =
        frozen <= prefix && 1 - first <= maxPos && matches(lines, pattern, 1, 0, suffixFuzz)
      return atTop ? 1 : null
    }
  }
  if (suffixFuzz < 0) {
    // GNU's rule, kept on purpose: diff writes a shorter trailing context
    // only at the end of a file, so a hunk with less context after its
    // change than before belongs at the end, even where its lines also sit
    // at the line its header names. GNU patch 2.8 edits the last occurrence
    // then, and fuzzes or fails a hunk the end of the file no longer
    // matches. Mirrors Python's _locate.
    const atEnd = lines.length - pattern.length + 1
    if (first - atEnd <= maxNeg && matches(lines, pattern, atEnd, prefixFuzz, 0)) return atEnd
    return null
  }
  const maxOffset = Math.max(maxPos, maxNeg)
  for (let offset = 0; offset <= maxOffset; offset++) {
    if (offset <= maxPos && matches(lines, pattern, first + offset, prefixFuzz, suffixFuzz))
      return first + offset
    if (
      offset > 0 &&
      offset <= maxNeg &&
      matches(lines, pattern, first - offset, prefixFuzz, suffixFuzz)
    )
      return first - offset
  }
  return null
}

// The first hunk fits only the other way round. Mirrors Python's _Reversed.
const REVERSED = 'reversed'

// The line and fuzz a hunk applies at, null when it does not. Each fuzz
// level is tried in turn, and with `probe` a level the hunk misses is tried
// the other way round too, as GNU does for a file's first hunk: a patch
// already applied is caught there before more fuzz lets it in somewhere
// else. Mirrors Python's _place.
function place(
  lines: readonly string[],
  hunk: Hunk,
  inOffset: number,
  frozen: number,
  probe: boolean,
): [number, number] | typeof REVERSED | null {
  const [prefix, suffix] = contextOf(hunk)
  const maxFuzz = Math.min(MAX_FUZZ, Math.max(prefix, suffix))
  for (let fuzz = 0; fuzz <= maxFuzz; fuzz++) {
    const where = locate(lines, hunk, inOffset, fuzz, frozen)
    if (where !== null) return [where, fuzz]
    if (probe && locate(lines, swapped(hunk), inOffset, fuzz, frozen) !== null) return REVERSED
  }
  return null
}

// Copy the file up to a hunk, then the hunk itself; the next line to copy.
// Context lines are the file's own, as GNU's `apply_hunk` copies them, so a
// line fuzz let through keeps what the file says. Mirrors Python's _splice.
function splice(
  out: string[],
  lines: readonly string[],
  src: number,
  where: number,
  hunk: Hunk,
): number {
  out.push(...lines.slice(src, Math.max(where - 1, src)))
  let at = where - 1
  for (const line of hunk.body) {
    const kind = line.slice(0, 1)
    if (kind === ' ') {
      if (at >= src && at < lines.length) out.push(lines[at] ?? '')
      at += 1
    } else if (kind === '-') {
      at += 1
    } else {
      out.push(line.slice(1))
    }
  }
  return Math.max(at, src)
}

// A hunk for the reject file as it was tried (`-R` swaps it), with the
// output offset it was refused at.
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

// Apply one section's hunks to a file's lines, GNU patch's way: a hunk is
// placed by its context, at an offset or with fuzz when it has to be, and
// one that fits nowhere is rejected, never forced in. When the first hunk
// fits only the other way round the file is skipped as already applied (or
// reversed). Lines are reported in the output file's numbering: the input
// offset GNU found, plus what the hunks applied so far added. Mirrors
// Python's _apply_section.
function applySection(
  lines: readonly string[],
  hunks: readonly Hunk[],
  reverse: boolean,
  forward: boolean,
): Outcome {
  const out: string[] = []
  const notes: string[] = []
  const rejected: Rejected[] = []
  let src = 0
  let inOffset = 0
  let outOffset = 0
  let exact = true
  for (const [i, hunk] of hunks.entries()) {
    const number = i + 1
    const active = reverse ? swapped(hunk) : hunk
    const placed = place(lines, active, inOffset, src, number === 1)
    if (placed === REVERSED) {
      return {
        lines: null,
        notes: reversedNotes(reverse, forward),
        rejected: asTried(hunks, reverse),
        exact: false,
      }
    }
    if (placed === null) {
      notes.push(
        `Hunk #${String(number)} FAILED at ${String(firstOf(active) + inOffset + outOffset)}.`,
      )
      rejected.push([active, outOffset])
      exact = false
      continue
    }
    const [where, fuzz] = placed
    inOffset = where - firstOf(active)
    src = splice(out, lines, src, where, active)
    if (fuzz > 0 || inOffset !== 0) {
      exact = false
      let note = `Hunk #${String(number)} succeeded at ${String(where + outOffset)}`
      if (fuzz > 0) note += ` with fuzz ${String(fuzz)}`
      if (inOffset !== 0) note += ` (offset ${String(inOffset)} line${inOffset === 1 ? '' : 's'})`
      notes.push(note + '.')
    }
    const [old, added] = sizesOf(active)
    outOffset += added - old
  }
  out.push(...lines.slice(src))
  return { lines: out, notes, rejected, exact }
}

// GNU's reject file: the section's names (`-R` swaps them as it did the
// hunks), then each hunk as it was tried. Mirrors Python's _reject_text.
function rejectText(section: Section, rejected: readonly Rejected[], reverse: boolean): Uint8Array {
  const [first, second] = reverse
    ? [section.newLabel, section.oldLabel]
    : [section.oldLabel, section.newLabel]
  const lines = [`--- ${first}`, `+++ ${second}`]
  for (const [hunk, outOffset] of rejected) lines.push(...rejectedLines(hunk, outOffset))
  return ENC.encode(lines.map((line) => `${line}\n`).join(''))
}

function companion(spec: PathSpec, suffix: string): PathSpec {
  return PathSpec.fromStrPath(spec.virtual + suffix, spec.vfsPath + suffix)
}

// Where one section's report and bytes go.
interface PatchSink {
  readonly report: string[]
  readonly writes: Record<string, Uint8Array>
  readonly written: Set<string>
  readonly write: (p: PathSpec, data: Uint8Array) => Promise<void>
}

// Write the hunks that did not go in to `.rej`, and say so. Mirrors Python's
// _save_rejects.
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
  const data = rejectText(section, rejected, reverse)
  await sink.write(reject, data)
  sink.writes[reject.mountPath] = data
}

// Apply one section to its file, GNU patch's way; true when a hunk of it was
// refused. A file that does not match the patch exactly is backed up to
// `.orig` the first time this run writes it, and the hunks that did not go
// in are saved to `.rej`. A file that is not there is not made unless a hunk
// applied, and a directory is refused whole. Mirrors Python's _patch_file.
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
  sink.report.push(...outcome.notes)
  if (outcome.lines !== null) {
    if (!outcome.exact && !sink.written.has(spec.virtual)) {
      if (original === null) {
        sink.report.push(`Cannot stat file ${shown}, skipping backup`)
      } else {
        const backup = companion(spec, '.orig')
        await sink.write(backup, original)
        sink.writes[backup.mountPath] = original
      }
    }
    if (original !== null || outcome.rejected.length < section.hunks.length) {
      const data = ENC.encode(outcome.lines.map((line) => `${line}\n`).join(''))
      await sink.write(spec, data)
      sink.writes[spec.mountPath] = data
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
  opts: CommandOpts,
  read: (p: PathSpec) => Promise<Uint8Array>,
): Promise<Uint8Array | string | null> {
  if (source === null) return readStdinAsync(opts.stdin)
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
    strip: fl.asInt('p') ?? 0,
    reverse: fl.asBool('R'),
    inputPath: input instanceof PathSpec ? input : (fl.asStr('i') ?? null),
    forward: fl.asBool('N'),
  }
}

export async function patchGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  read: (p: PathSpec) => Promise<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags)
  if (paths.length > 2) throw extraOperandError(CommandName.PATCH, paths[2]?.rawPath ?? '')
  const { strip: stripCount, reverse: reverseMode, forward: forwardOnly, inputPath } = parsed
  const mountPrefix = opts.mountPrefix ?? ''
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
  const loaded = await loadPatchData(source, opts, read)
  if (typeof loaded === 'string') {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(loaded) })]
  }
  if (loaded === null || loaded.byteLength === 0) {
    return [null, new IOResult()]
  }

  const sections = parsePatch(DEC.decode(loaded), stripCount)
  const orig = paths[0] ?? null
  const sink: PatchSink = { report: [], writes: {}, written: new Set<string>(), write }
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
  return [out, new IOResult({ writes: sink.writes, exitCode: failed ? 1 : 0 })]
}
