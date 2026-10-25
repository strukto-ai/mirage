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

import { encodeText } from '../../shell/bytes.ts'
import { closeQuietly } from '../../io/stream.ts'
import { materialize, type IOResult } from '../../io/types.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import { StreamRefusal } from '../../rs/errors.ts'
import { openStream, type OpenStream } from '../../rs/stream.ts'
import type { JsonValue } from '../../types.ts'
import { concat } from '../../utils/bytes.ts'
import { UsageError } from '../errors.ts'
import { PROBE_BLOCK_BYTES, groupLine, type FlagSet } from './grep_binary.ts'
import { RegexSyntax } from './types.ts'

/** Bytes as the stream reads them: one character per byte. Mirrors Python's latin1. */
export function latin1(data: Uint8Array): string {
  // A piece at a time: spreading a large array overflows the call stack.
  const piece = 8192
  let text = ''
  for (let offset = 0; offset < data.byteLength; offset += piece)
    text += String.fromCharCode(...data.subarray(offset, offset + piece))
  return text
}

/**
 * The mirage-rs grep stream's configuration for a command line; a null
 * pattern is a -f list of no patterns, which matches nothing. Mirrors
 * Python's stream_config.
 */
export function streamConfig(
  f: FlagSet,
  pattern: string | null,
  utf8: boolean,
): Record<string, JsonValue> {
  const patterns: Uint8Array[] = []
  if (pattern !== null) {
    const data = encodeText(pattern)
    let start = 0
    for (let at = data.indexOf(10); at !== -1; at = data.indexOf(10, start)) {
      patterns.push(data.subarray(start, at))
      start = at + 1
    }
    patterns.push(data.subarray(start))
  }
  const syntax = f.fixedString
    ? 'fixed'
    : f.syntax === RegexSyntax.PERL
      ? 'perl'
      : f.syntax === RegexSyntax.EXTENDED
        ? 'extended'
        : 'basic'
  const separator = groupLine(f)
  return {
    patterns: patterns.map(latin1),
    syntax,
    ignore_case: f.ignoreCase,
    word: f.wholeWord,
    line: f.lineRegexp,
    utf8,
    invert: f.invert,
    line_numbers: f.lineNumbers,
    byte_offsets: f.byteOffsets,
    count: f.countOnly,
    files_with_matches: f.filesOnly,
    files_without_match: f.filesWithoutMatch,
    quiet: f.quiet,
    only_matching: f.onlyMatching,
    max_count: f.maxCount,
    after: f.afterContext ?? 0,
    before: f.beforeContext ?? 0,
    binary: f.binaryMode,
    null_data: f.nullData === true,
    null: f.null === true,
    initial_tab: f.initialTab === true,
    separator: separator === '' ? null : latin1(encodeText(separator)),
  }
}

/**
 * Compile the pattern list once for the whole command line: the stream,
 * and GNU's warnings about the patterns as stderr. A pattern GNU grep
 * refuses is a UsageError in its wording (exit 2). The caller closes the
 * stream. Mirrors Python's open_grep.
 */
export async function openGrep(
  config: Record<string, JsonValue>,
): Promise<[OpenStream, Uint8Array]> {
  let stream: OpenStream
  try {
    stream = await openStream('grep', config)
  } catch (error) {
    if (error instanceof StreamRefusal) throw new UsageError(`grep: ${error.message}`)
    throw error
  }
  return [stream, stream.takeStderr()]
}

/** Record the input's status and any notice as soon as they change. Mirrors Python's settle. */
async function settle(stream: OpenStream, io: IOResult): Promise<void> {
  io.exitCode = stream.status()
  const notice = stream.takeStderr()
  if (notice.byteLength > 0) io.stderr = concat([await materialize(io.stderr), notice])
}

/** One call's output, then the rest of its work while it is busy. Mirrors Python's drained. */
async function* drained(
  stream: OpenStream,
  output: Uint8Array,
  io: IOResult,
  budget: YieldBudget,
): AsyncIterable<Uint8Array> {
  for (;;) {
    await settle(stream, io)
    if (output.byteLength > 0) yield output
    if (!stream.busy()) return
    await budget.run()
    output = stream.drain()
  }
}

/**
 * Run one input through the grep stream, yielding grep's output for it.
 * Each chunk the backend serves is cut into probe-sized blocks, every one a
 * block of the binary-file probe. A back-reference search that needs more
 * than one call's steps leaves the stream busy, and the rest runs a bounded
 * step per `drain`, so an abort lands between steps. Mirrors Python's
 * stream_input.
 */
export async function* streamInput(
  source: AsyncIterable<Uint8Array>,
  stream: OpenStream,
  path: string,
  showFilename: boolean,
  io: IOResult,
  afterOutput = false,
  size: number | null = null,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  const budget = new YieldBudget(signal)
  stream.begin({
    label: latin1(encodeText(path)),
    show_filename: showFilename,
    size,
    after_output: afterOutput,
  })
  io.exitCode = 1
  try {
    // -m0 reads nothing.
    if (!stream.done()) {
      reading: for await (const chunk of source) {
        for (let offset = 0; offset < chunk.byteLength; offset += PROBE_BLOCK_BYTES) {
          if (stream.done()) break reading
          await budget.run()
          const output = stream.feed(chunk.subarray(offset, offset + PROBE_BLOCK_BYTES))
          yield* drained(stream, output, io, budget)
        }
        if (stream.done()) break
      }
    }
  } finally {
    await closeQuietly(source)
  }
  yield* drained(stream, stream.finish(), io, budget)
}
