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

import { YieldBudget } from '../../io/yield_budget.ts'
import { closeQuietly } from '../../io/stream.ts'
import { decodeLine, encodeLine, MatchOffsets, prefixOf } from './grep_offsets.ts'
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
  fixedString: boolean
  basicRegexp: boolean
  onlyMatching: boolean
  maxCount: number | null
  quiet: boolean
  withFilename: boolean
  noFilename: boolean
  afterContext: number
  beforeContext: number
}

// GNU grep's INITIAL_BUFSIZE: the window it examines before printing from it.
export const PROBE_BLOCK_BYTES = 96 * 1024

export class BinaryInput {
  nul = false
  constructor(readonly mode: string) {}

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
    if (this.mode !== 'text' && !this.nul && data.includes(0)) this.nul = true
    return this.nul && this.mode === 'without-match'
  }

  private deliver(block: Uint8Array): Uint8Array {
    return this.nul ? block.map((byte) => (byte === 0 ? 10 : byte)) : block
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
 * is the line's own start, or the match itself under -o.
 */
function outputLine(
  raw: Uint8Array,
  number: number,
  selected: boolean,
  path: string,
  showFilename: boolean,
  f: FlagSet,
  offset = 0,
): Uint8Array {
  const separator = selected ? ':' : '-'
  const prefix = ENC.encode(
    (showFilename ? path + separator : '') +
      prefixOf(f.lineNumbers ? number : null, f.byteOffsets ? offset : null, selected),
  )
  const out = new Uint8Array(prefix.length + raw.length + 1)
  out.set(prefix)
  out.set(raw, prefix.length)
  out[out.length - 1] = 10
  return out
}

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
): AsyncIterable<Uint8Array> {
  const budget = new YieldBudget(signal)
  io.exitCode = 1
  pat = utf8Pattern(pat)
  const binary = new BinaryInput(f.binaryMode)
  let count = 0
  let notified = false
  const previous: [number, Uint8Array, number][] = []
  let lastPrinted = 0
  let afterUntil = 0
  const hasContext = (f.afterContext > 0 || f.beforeContext > 0) && !f.onlyMatching
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
    if (f.filesWithoutMatch && !f.quiet) yield ENC.encode(path + '\n')
    return
  }
  let number = 0
  // GNU counts BYTES from the start of the input and keeps counting across
  // lines, so the position advances by one more than the line to cover the
  // terminator the iterator strips. The extra byte past a final line with no
  // newline is never read.
  let bytePos = 0
  const input = binary.read(source)
  try {
    for await (const raw of new AsyncLineIterator(input)) {
      if (binary.nul && f.binaryMode === 'without-match') break
      number += 1
      const lineStart = bytePos
      bytePos += raw.length + 1
      const line = decodeLine(raw)
      let hit = pat.test(line) !== f.invert
      if (f.maxCount !== null && count >= f.maxCount) hit = false
      if (hit) {
        count += 1
        io.exitCode = 0
        if (f.quiet) return
        if (f.filesOnly) {
          yield ENC.encode(path + '\n')
          return
        }
        // A selected line is all -L needs to know: the file is not listed,
        // and the status still says it matched.
        if (f.filesWithoutMatch) return
      }
      if (f.countOnly) {
        if (f.maxCount !== null && count >= f.maxCount) break
        continue
      }
      const chunks: Uint8Array[] = []
      if (hit) {
        if (f.onlyMatching) {
          if (!f.invert) {
            const re = new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags + 'g')
            const offsets = f.byteOffsets ? new MatchOffsets(lineStart, line) : null
            for (const m of line.matchAll(re)) {
              const pending = budget.run()
              if (pending !== undefined) await pending
              if (m[0] !== '')
                chunks.push(
                  outputLine(
                    encodeLine(m[0]),
                    number,
                    true,
                    path,
                    showFilename,
                    f,
                    offsets?.at(m.index) ?? 0,
                  ),
                )
            }
          }
        } else {
          if (hasContext) {
            const pending = previous.filter(([n]) => n > lastPrinted)
            const first = pending[0]?.[0] ?? number
            if ((lastPrinted && first > lastPrinted + 1) || (!lastPrinted && afterOutput))
              chunks.push(ENC.encode('--\n'))
            for (const [n, data, at] of pending)
              chunks.push(outputLine(data, n, false, path, showFilename, f, at))
          }
          chunks.push(outputLine(raw, number, true, path, showFilename, f, lineStart))
          lastPrinted = number
          afterUntil = number + f.afterContext
        }
      } else if (hasContext && number <= afterUntil) {
        chunks.push(outputLine(raw, number, false, path, showFilename, f, lineStart))
        lastPrinted = number
      }
      // A selected line with nothing to print (-o on a zero-width match)
      // still earns the notice.
      if (hit && chunks.length === 0 && binary.nul && f.binaryMode === 'binary' && !notified) {
        binaryNotice(io, path)
        notified = true
      }
      for (const chunk of chunks) {
        if (f.binaryMode !== 'text' && (binary.nul || !validUtf8(chunk))) {
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
      if (previous.length > f.beforeContext) previous.shift()
      if (f.maxCount !== null && count >= f.maxCount && number >= afterUntil) break
    }
  } finally {
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
    yield ENC.encode(path + '\n')
    return
  }
  if (f.countOnly && !(f.quiet || f.filesOnly))
    yield ENC.encode((showFilename ? path + ':' : '') + String(count) + '\n')
}

function utf8Pattern(pat: RegExp): RegExp {
  let pattern = ''
  let escaped = false
  let inClass = false
  let classStart = 0
  for (let index = 0; index < pat.source.length; index += 1) {
    const char = pat.source.charAt(index)
    if (escaped) {
      pattern += char
      escaped = false
    } else if (char === '\\') {
      pattern += char
      escaped = true
    } else if (char === '[' && !inClass) {
      pattern += char
      inClass = true
      // A leading ] after an optional ^ is a class member.
      classStart = index + 1
      if (pat.source.charAt(classStart) === '^') classStart += 1
    } else if (char === ']' && inClass && index > classStart) {
      pattern += char
      inClass = false
    } else if (char === '.' && !inClass) pattern += '[^\\n\\udc80-\\udcff]'
    else pattern += char
  }
  return new RegExp(pattern, pat.flags)
}
