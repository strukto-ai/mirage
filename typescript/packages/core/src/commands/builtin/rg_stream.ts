import { z } from 'zod'

import type { Worker } from '../../concurrency/worker.ts'
import { closeQuietly, discardStreams } from '../../io/stream.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import { StreamRefusal } from '../../rs/errors.ts'
import type { OpenStream } from '../../rs/stream.ts'
import { openStream } from '../../rs/stream.ts'
import { encodeText } from '../../shell/bytes.ts'
import type { JsonValue } from '../../types.ts'
import { UsageError } from '../errors.ts'
import {
  RgBinary,
  searchHaystack,
  transcoded,
  type RgFlags,
  type Tally,
  type Totals,
} from './rg_search.ts'

const COMPILED = z.object({
  terms: z
    .object({ texts: z.array(z.string()), whole_word: z.boolean(), ignore_case: z.boolean() })
    .nullable(),
})
export type SearchHints = NonNullable<z.infer<typeof COMPILED>['terms']>
type Compiled = z.infer<typeof COMPILED>
const TALLY = z.object({
  selected: z.boolean(),
  binary: z.boolean(),
  skipped: z.boolean(),
  matches: z.number().nonnegative(),
  matched_lines: z.number().nonnegative(),
  searched: z.number().nonnegative(),
  nul: z.number().nonnegative().nullable(),
})
const BLOCK_BYTES = 64 * 1024
const DEC = new TextDecoder()
const ENC = new TextEncoder()

export class RgProgram {
  constructor(readonly stream: OpenStream) {}
}

export type RgPattern = RegExp | RgProgram

export function latin1(text: string): string {
  const data = encodeText(text)
  const pieces: string[] = []
  for (let at = 0; at < data.length; at += 8192)
    pieces.push(String.fromCharCode(...data.subarray(at, at + 8192)))
  return pieces.join('')
}

export function streamConfig(
  pattern: string,
  neverMatch: boolean,
  f: RgFlags,
  regexSizeLimit: number | null = null,
  dfaSizeLimit: number | null = null,
): Record<string, JsonValue> {
  return {
    pattern,
    never_match: neverMatch,
    ban_nul: !(f.text || f.nullData),
    regex_size_limit: regexSizeLimit,
    dfa_size_limit: dfaSizeLimit,
    ignore_case: f.ignoreCase,
    smart_case: f.smartCase,
    whole_word: f.wholeWord,
    line_regexp: f.lineRegexp,
    fixed_string: f.fixedString,
    unicode: f.unicode,
    multiline: f.multiline === true,
    multiline_dotall: f.multilineDotall === true,
    crlf: f.crlf === true,
    null_data: f.nullData,
    invert: f.invert,
    line_numbers: f.lineNumbers,
    column: f.column,
    vimgrep: f.vimgrep,
    byte_offsets: f.byteOffsets,
    only_matching: f.onlyMatching,
    trim: f.trim,
    max_columns_preview: f.maxColumnsPreview,
    null: f.null,
    quiet: f.quiet,
    count_only: f.countOnly,
    count_matches: f.countMatches,
    include_zero: f.includeZero,
    files_only: f.filesOnly,
    files_without_match: f.filesWithoutMatch,
    heading: f.heading,
    passthru: f.passthru,
    stop_on_nonmatch: f.stopOnNonmatch,
    stats: f.stats === true,
    json: f.json === true,
    max_columns: f.maxColumns,
    max_count: f.maxCount,
    context_after: f.contextAfter,
    context_before: f.contextBefore,
    replace: f.replace === null ? null : latin1(f.replace),
    context_separator: f.contextSeparator === null ? null : latin1(f.contextSeparator),
    field_match_separator: latin1(f.fieldMatchSeparator),
    field_context_separator: latin1(f.fieldContextSeparator),
  }
}

export async function openRg(
  pattern: string,
  neverMatch: boolean,
  f: RgFlags,
  regexSizeLimit: number | null = null,
  dfaSizeLimit: number | null = null,
): Promise<RgProgram> {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(encodeText(pattern))
  } catch (error) {
    if (error instanceof TypeError) throw new UsageError('rg: pattern given is not valid UTF-8')
    throw error
  }
  try {
    return new RgProgram(
      await openStream('rg', streamConfig(pattern, neverMatch, f, regexSizeLimit, dfaSizeLimit)),
    )
  } catch (error) {
    if (error instanceof StreamRefusal) throw new UsageError(`rg: ${error.message}`)
    throw error
  }
}

export function settle(stream: OpenStream, tally: Tally): void {
  const progress = TALLY.parse(JSON.parse(DEC.decode(stream.metadata())))
  tally.selected = progress.selected
  tally.binary = progress.binary
  tally.skipped = progress.skipped
  tally.matches = progress.matches
  tally.matchedLines = progress.matched_lines
  tally.searched = progress.searched
  tally.nul = progress.nul
}

async function* drained(
  stream: OpenStream,
  output: Uint8Array,
  tally: Tally,
  budget: YieldBudget,
): AsyncGenerator<Uint8Array> {
  for (;;) {
    settle(stream, tally)
    if (output.byteLength > 0) yield output
    if (!stream.busy()) return
    await budget.run()
    output = stream.drain()
  }
}

export function binaryMetadata(binary: RgBinary): Record<string, JsonValue> {
  return {
    binary_offset: binary.offset,
    binary_converted: binary.converted,
    binary_skipped: binary.skipped,
  }
}

async function* streamHaystack(
  source: AsyncIterable<Uint8Array>,
  program: RgProgram,
  f: RgFlags,
  name: string,
  label: string | null,
  tally: Tally,
  signal: AbortSignal | undefined,
  named: boolean,
  pipe: boolean,
): AsyncGenerator<Uint8Array> {
  const stream = program.stream
  const binary = new RgBinary(
    f.text || f.nullData
      ? 'text'
      : f.json === true && (named || f.binary)
        ? 'note'
        : named || f.binary
          ? 'convert'
          : 'quit',
  )
  stream.begin({
    name: latin1(name),
    label: label === null ? null : latin1(label),
    binary_mode: binary.mode,
    ...binaryMetadata(binary),
  })
  const encoding = f.encoding ?? 'auto'
  const reader = binary.read(encoding === 'none' ? source : transcoded(source, encoding), pipe)
  const budget = new YieldBudget(signal)
  try {
    if (!stream.done()) {
      for await (const chunk of reader) {
        stream.feedInput(1, ENC.encode(JSON.stringify(binaryMetadata(binary))))
        for (let offset = 0; offset < chunk.byteLength; offset += BLOCK_BYTES) {
          if (stream.done()) break
          await budget.run()
          yield* drained(
            stream,
            stream.feed(chunk.subarray(offset, offset + BLOCK_BYTES)),
            tally,
            budget,
          )
        }
        if (stream.done()) break
      }
    }
    stream.feedInput(1, ENC.encode(JSON.stringify(binaryMetadata(binary))))
    yield* drained(stream, stream.finish(), tally, budget)
  } catch (error) {
    await discardStreams(source)
    throw error
  } finally {
    settle(stream, tally)
    await closeQuietly(reader)
    await closeQuietly(source)
  }
}

export async function* searchInput(
  source: AsyncIterable<Uint8Array>,
  pat: RgPattern,
  f: RgFlags,
  name: string,
  label: string | null,
  tally: Tally,
  signal?: AbortSignal,
  named = true,
  pipe = false,
  worker?: Worker,
): AsyncGenerator<Uint8Array> {
  const result =
    pat instanceof RgProgram
      ? streamHaystack(source, pat, f, name, label, tally, signal, named, pipe)
      : searchHaystack(source, pat, f, name, label, tally, signal, named, pipe, worker)
  try {
    yield* result
  } finally {
    await closeQuietly(result)
  }
}

export function formatOutput(program: RgProgram, message: Record<string, JsonValue>): Uint8Array {
  return program.stream.feedInput(2, ENC.encode(JSON.stringify(message)))
}

export function totalsConfig(totals: Totals): Record<string, JsonValue> {
  return {
    matches: totals.matches,
    matched_lines: totals.matchedLines,
    with_match: totals.withMatch,
    searched: totals.searched,
    printed: totals.printed,
    bytes_searched: totals.bytesSearched,
    elapsed: totals.elapsed,
  }
}

export async function formatTotals(
  totals: Totals,
  kind: 'summary' | 'stats',
  total: number,
): Promise<Uint8Array> {
  const stream = await openStream('rg_format', {})
  try {
    return stream.feed(ENC.encode(JSON.stringify({ kind, totals: totalsConfig(totals), total })))
  } finally {
    stream.close()
  }
}

export function requiredTerms(program: RgProgram): SearchHints | null {
  const compiled: Compiled = COMPILED.parse(JSON.parse(DEC.decode(program.stream.metadata())))
  return compiled.terms
}
