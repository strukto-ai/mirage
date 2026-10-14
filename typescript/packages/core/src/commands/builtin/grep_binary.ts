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

import type { Worker } from '../../concurrency/worker.ts'
import { AsyncRegex } from '../../utils/regex.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import { closeQuietly } from '../../io/stream.ts'
import { prefixOf } from './grep_offsets.ts'
import { byteView, encodeText, fromByteView } from '../../shell/bytes.ts'
import { requiredNeedles } from './grep_prefilter.ts'
import type { RegexSyntax } from './types.ts'
import { matchStart, matchText } from './utils/pcre.ts'
import { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import type { IOResult } from '../../io/types.ts'
import type { WalkFilters } from './grep_select.ts'

const ENC = new TextEncoder()

export interface FlagSet {
  filters: WalkFilters
  binaryMode: string
  recursive: boolean
  ignoreCase: boolean
  invert: boolean
  lineNumbers: boolean
  byteOffsets: boolean
  countOnly: boolean
  filesOnly: boolean
  filesWithoutMatch: boolean
  wholeWord: boolean
  lineRegexp: boolean
  fixedString: boolean
  syntax: RegexSyntax
  onlyMatching: boolean
  maxCount: number | null
  quiet: boolean
  noMessages: boolean
  withFilename: boolean
  noFilename: boolean
  afterContext: number | null
  beforeContext: number | null
  skipDirectories?: boolean
  skipDevices?: boolean
  nullData?: boolean
  null?: boolean
  initialTab?: boolean
  groupSeparator?: string | null
  label?: string
  dereference?: boolean
}

// GNU grep's INITIAL_BUFSIZE: the window it examines before printing from it.
export const PROBE_BLOCK_BYTES = 96 * 1024
// The digits of INTMAX_MAX, the width -T pads to when the input's size is
// unknown (a pipe).
const UNKNOWN_SIZE_WIDTH = 19

/**
 * The line grep prints between two context groups, or nothing. GNU separates
 * groups once -A, -B or -C is given, zero included and under -o too (grep
 * 3.11: `grep -A0` prints `--` between two lines that are not neighbours);
 * -c, -l, -L and -q print no lines.
 */
export function groupLine(f: FlagSet): string {
  if (f.countOnly || f.filesOnly || f.filesWithoutMatch || f.quiet) return ''
  const separator = f.groupSeparator === undefined ? '--' : f.groupSeparator
  if (separator === null || (f.afterContext === null && f.beforeContext === null)) return ''
  return separator + '\n'
}

/** What follows a file name -l or -L prints: NUL under -Z. */
export function nameEnd(f: FlagSet): string {
  return f.null === true ? '\0' : '\n'
}

/**
 * The width -T pads line numbers and byte offsets to. GNU sizes the field to
 * the digits of the file's size, plus one under -n, and to INTMAX_MAX's
 * digits when the size is unknown (grep.c).
 */
function offsetWidth(f: FlagSet, size: number | null): number {
  if (f.initialTab !== true) return 0
  if (size === null) return UNKNOWN_SIZE_WIDTH
  return String(size + (f.lineNumbers ? 1 : 0)).length
}

export class BinaryInput {
  nul = false
  // Under -z a NUL ends a line, so it is no sign of a binary file.
  constructor(
    readonly mode: string,
    readonly nulEndsLine = false,
  ) {}

  /**
   * Probe the input for NUL a block at a time, then pass it on. GNU examines
   * what one read() returned before printing from it: a whole buffer for a
   * regular file, whatever had arrived for a pipe. A transport chunk is the
   * pipe case, and it is not merged with later chunks because a -m1 over a
   * row stream must not pull the rest of the collection to fill a window; a
   * chunk a backend serves whole is cut into GNU-sized blocks so it behaves
   * as the file case.
   */
  async *read(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
    for await (const chunk of source) {
      for (let offset = 0; offset < chunk.length; offset += PROBE_BLOCK_BYTES) {
        const block = chunk.subarray(offset, offset + PROBE_BLOCK_BYTES)
        if (this.stops(block)) return
        yield this.deliver(block)
      }
    }
  }

  // Note a NUL in data, which all belongs to the block being probed; true
  // when without-match must stop reading.
  private stops(data: Uint8Array): boolean {
    if (this.mode !== 'text' && !this.nulEndsLine && !this.nul && data.includes(0)) this.nul = true
    return this.nul && this.mode === 'without-match'
  }

  private deliver(block: Uint8Array): Uint8Array {
    if (!this.nul) return block
    const out = new Uint8Array(block)
    for (let at = 0; at < out.length; at++) if (out[at] === 0) out[at] = 10
    return out
  }
}

/** Append GNU's binary-file notice to the input's stderr. */
function binaryNotice(io: IOResult, path: string): void {
  const old = io.stderr instanceof Uint8Array ? io.stderr : new Uint8Array()
  const notice = ENC.encode(`grep: ${path}: binary file matches\n`)
  const err = new Uint8Array(old.length + notice.length)
  err.set(old)
  err.set(notice, old.length)
  io.stderr = err
}

/** Whether every byte of `data` belongs to a UTF-8 character. */
export function validUtf8(data: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
    return true
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    return false
  }
}

/**
 * One output line, prefix fields in GNU's fixed order: filename, then line
 * number, then byte offset, whatever order the flags were given in. `offset`
 * is the line's own start, or the match itself under -o. -Z puts a NUL after
 * the name in place of its separator, -T pads the numbers to `width` and puts
 * a tab before a nonempty line, and -z ends the line with a NUL.
 */
function outputLine(
  raw: Uint8Array,
  number: number,
  selected: boolean,
  path: string,
  showFilename: boolean,
  f: FlagSet,
  offset = 0,
  width = 0,
): Uint8Array {
  const separator = selected ? ':' : '-'
  const name = showFilename ? path + (f.null === true ? '\0' : separator) : ''
  const fields = prefixOf(
    f.lineNumbers ? number : null,
    f.byteOffsets ? offset : null,
    selected,
    width,
  )
  const tab = f.initialTab === true && (name || fields) && raw.length > 0 ? '\t' : ''
  const prefix = ENC.encode(name + fields + tab)
  const out = new Uint8Array(prefix.length + raw.length + 1)
  out.set(prefix)
  out.set(raw, prefix.length)
  out[out.length - 1] = f.nullData === true ? 0 : 10
  return out
}

/**
 * Scan one input, yielding grep's output for it. Under a UTF-8 locale
 * (`utf8`) a line is matched as text, and a line or match to print that holds
 * a byte no character owns is binary output: GNU leaves it out and ends with
 * the binary-file notice, as it does for a NUL, but goes on printing the lines
 * after it.
 */
export async function* grepInput(
  source: AsyncIterable<Uint8Array>,
  pat: RegExp,
  f: FlagSet,
  path: string,
  showFilename: boolean,
  io: IOResult,
  // Whether an earlier input already printed lines; GNU then opens this
  // input's first context group with the separator, as it does between
  // groups within one input.
  afterOutput = false,
  signal?: AbortSignal,
  utf8 = false,
  // The input's size, which -T sizes its fields to; null for a pipe.
  size: number | null = null,
  worker?: Worker,
): AsyncIterable<Uint8Array> {
  const budget = new YieldBudget(signal)
  io.exitCode = 1
  const eol = f.nullData === true ? 0 : 10
  const width = offsetWidth(f, size)
  const binary = new BinaryInput(f.binaryMode, f.nullData === true)
  let count = 0
  let notified = false
  const after = f.afterContext ?? 0
  const before = f.beforeContext ?? 0
  const previous: [number, Uint8Array, number][] = []
  const separator = groupLine(f)
  let lastPrinted = 0
  let afterUntil = 0
  // Context lines are tracked under -o too, which prints none of them but
  // still separates the groups they belong to.
  const hasContext = after > 0 || before > 0
  if (f.maxCount === 0) {
    // GNU selects no line at all and the whole command goes quiet:
    // `grep -m0 -c a f` prints NOTHING and exits 1, and so does
    // `grep -m0 -c a f g` -- no per-file zeros either. That is not the same
    // as a genuine zero, which `grep -c a g` still prints as `0`, so -c
    // cannot answer from the count here. Measured on GNU grep 3.11 across
    // `-m0`, `-m 0` and `--max-count=0`.
    // Nothing is read, but the backend already opened the source.
    // -L is the one flag that still speaks: nothing selected means the
    // file is listed (`grep -m0 -L a f` prints f, exit 1).
    await closeQuietly(source)
    if (f.filesWithoutMatch && !f.quiet) yield ENC.encode(path + nameEnd(f))
    return
  }
  let number = 0
  // GNU counts BYTES from the start of the input and keeps counting across
  // lines, so the position advances by one more than the line to cover the
  // terminator the iterator strips. The extra byte past a final line with no
  // newline is never read.
  let bytePos = 0
  const needles =
    !f.invert && (!hasContext || f.countOnly || f.quiet || f.filesOnly || f.filesWithoutMatch)
      ? requiredNeedles(pat)
      : null
  const pattern = new AsyncRegex(pat, signal, f.onlyMatching, worker)
  pat = pattern
  const input = binary.read(source)
  const lines = new AsyncLineIterator(input)
  try {
    for (;;) {
      if (needles !== null) {
        const [skipped, bytes] = lines.skipNonmatchingLines(needles, pat.ignoreCase, eol)
        number += skipped
        bytePos += bytes
      }
      const raw = await lines.readline(signal, eol)
      if (raw === null) break
      if (binary.nul && f.binaryMode === 'without-match') break
      number += 1
      const lineStart = bytePos
      bytePos += raw.length + 1
      const line = byteView(raw, utf8)
      await pattern.prepare(line, () =>
        f.maxCount === null && !(f.quiet || f.filesOnly || f.filesWithoutMatch)
          ? lines
              .bufferedLines(eol, 31, needles, pat.ignoreCase)
              .map((item) => byteView(item, utf8))
          : [],
      )
      let hit = pat.test(line) !== f.invert
      if (f.maxCount !== null && count >= f.maxCount) hit = false
      if (hit) {
        count += 1
        io.exitCode = 0
        if (f.quiet) return
        if (f.filesOnly) {
          yield ENC.encode(path + nameEnd(f))
          return
        }
        // A selected line is all -L needs to know: the file is not listed,
        // and the status still says it matched.
        if (f.filesWithoutMatch) return
      }
      // NUL runs become empty lines. Batch identical decisions within the
      // current buffer when no per-line output or context must be retained.
      if (raw.length === 0 && (f.countOnly || (!hit && !hasContext))) {
        const limit = hit && f.maxCount !== null ? f.maxCount - count : Infinity
        const skipped = lines.skipEmptyLines(limit, eol)
        number += skipped
        bytePos += skipped
        if (hit) count += skipped
      }
      if (f.countOnly) {
        if (f.maxCount !== null && count >= f.maxCount) break
        continue
      }
      const chunks: Uint8Array[] = []
      if (hit) {
        const pending = previous.filter(([n]) => n > lastPrinted)
        const first = pending[0]?.[0] ?? number
        if (
          separator &&
          ((lastPrinted && first > lastPrinted + 1) || (!lastPrinted && afterOutput))
        )
          chunks.push(ENC.encode(separator))
        if (!f.onlyMatching)
          for (const [n, data, at] of pending)
            chunks.push(outputLine(data, n, false, path, showFilename, f, at, width))
        lastPrinted = number
        afterUntil = number + after
        if (f.onlyMatching) {
          if (!f.invert) {
            for (const m of pattern.matches(line)) {
              const pending = budget.run()
              if (pending !== undefined) await pending
              const text = matchText(m)
              const start = matchStart(m)
              if (text !== '')
                chunks.push(
                  outputLine(
                    fromByteView(text, utf8),
                    number,
                    true,
                    path,
                    showFilename,
                    f,
                    lineStart + (utf8 ? encodeText(line.slice(0, start)).length : start),
                    width,
                  ),
                )
            }
          }
        } else {
          chunks.push(outputLine(raw, number, true, path, showFilename, f, lineStart, width))
        }
      } else if (number <= afterUntil) {
        if (!f.onlyMatching)
          chunks.push(outputLine(raw, number, false, path, showFilename, f, lineStart, width))
        lastPrinted = number
      }
      // A selected line with nothing to print (-o on a zero-width match)
      // still earns the notice.
      if (hit && chunks.length === 0 && binary.nul && f.binaryMode === 'binary' && !notified) {
        binaryNotice(io, path)
        notified = true
      }
      for (const chunk of chunks) {
        if (f.binaryMode !== 'text' && (binary.nul || (utf8 && !validUtf8(chunk)))) {
          if (f.binaryMode === 'binary' && !notified) {
            binaryNotice(io, path)
            notified = true
          }
          continue
        }
        yield chunk
      }
      if (binary.nul && count && f.binaryMode === 'binary') return
      previous.push([number, raw, lineStart])
      if (previous.length > before) previous.shift()
      if (f.maxCount !== null && count >= f.maxCount && number >= afterUntil) break
    }
  } finally {
    await pattern.close()
    await closeQuietly(input)
    await closeQuietly(source)
  }

  // Detection can end input without yielding another line.
  if (binary.nul && f.binaryMode === 'without-match') {
    count = 0
    io.exitCode = 1
  }

  // -L lists the file once it is known to hold no selected line, and
  // outranks -c (GNU 3.11: `grep -L -c hello m o` prints only `o`).
  if (f.filesWithoutMatch && !f.quiet) {
    yield ENC.encode(path + nameEnd(f))
    return
  }
  if (f.countOnly && !(f.quiet || f.filesOnly)) {
    const label = path + (f.null === true ? '\0' : ':')
    yield ENC.encode((showFilename ? label : '') + String(count) + '\n')
  }
}
