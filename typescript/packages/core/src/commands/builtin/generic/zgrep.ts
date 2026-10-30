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

import { encodeText, utf8Locale } from '../../../shell/bytes.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import type { PathSpec, StatFn } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { matcherSyntax, resolvePattern } from '../grep_pattern.ts'
import { UsageError } from '../../errors.ts'
import { GREP_STDIN_LABEL, STDIN_OPERAND } from '../utils/constants.ts'
import { linkResolver } from '../utils/links.ts'
import { operandLabel } from '../utils/stream.ts'
import { decompressInputs } from './decompress.ts'
import { listingMode, maxCount } from './grep.ts'
import type { FlagSet } from '../grep_binary.ts'
import { exitCodeFor } from '../grep_scan.ts'
import { openGrep, streamConfig, streamInput } from '../grep_stream.ts'
import { OutputStream, closeQuietly, ensureStream } from '../../../io/stream.ts'
import { closeStream } from '../../../rs/stream.ts'
import { concat } from '../../../utils/bytes.ts'

const ZGREP_NO_PATTERN = "zgrep: missing pattern; try `zgrep --help' for help"

function parseFlags(fl: FlagView, neverMatch: boolean): FlagSet {
  const [filesOnly, filesWithoutMatch] = listingMode(fl)
  const count = maxCount(fl)
  return {
    ignoreCase: fl.asBool('ignore_case'),
    invert: fl.asBool('invert_match'),
    countOnly: fl.asBool('count'),
    filesOnly,
    filesWithoutMatch,
    lineNumbers: fl.asBool('line_number'),
    byteOffsets: fl.asBool('byte_offset'),
    fixedString: fl.asBool('fixed_strings') && !neverMatch,
    syntax: matcherSyntax(fl),
    withFilename: fl.asBool('with_filename'),
    noFilename: fl.asBool('no_filename'),
    onlyMatching: fl.asBool('only_matching'),
    quiet: fl.asBool('quiet') && count !== 0,
    wholeWord: fl.asBool('word_regexp'),
    lineRegexp: fl.asBool('line_regexp'),
    maxCount: count,
    noMessages: false,
    recursive: false,
    afterContext: null,
    beforeContext: null,
    binaryMode: 'binary',
    filters: { fileGlobs: [], excludeDir: [], text: false },
  }
}

export async function zgrepGeneric(
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  read: (p: PathSpec) => AsyncIterable<Uint8Array>,
  stat?: StatFn,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, specOf('zgrep'))
  const resolution = await resolvePattern('zgrep', texts, fl, read)
  if (resolution.error !== null) {
    return [null, new IOResult({ exitCode: 2, stderr: encodeText(resolution.error) })]
  }
  if (resolution.pattern === null) {
    return [null, new IOResult({ exitCode: 2, stderr: encodeText(ZGREP_NO_PATTERN + '\n') })]
  }
  let f: FlagSet
  try {
    f = parseFlags(fl, resolution.neverMatch)
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return [null, new IOResult({ exitCode: 2, stderr: encodeText(err.message + '\n') })]
  }
  const [stream, warnings] = await openGrep(
    streamConfig(
      f,
      resolution.neverMatch || f.maxCount === 0 ? null : resolution.pattern,
      utf8Locale(ctx.env),
    ),
  )
  const showFilename = f.withFilename || (paths.length > 1 && !f.noFilename)
  const resolver = linkResolver(ctx)
  const result = new IOResult({ exitCode: 1, stderr: warnings.length ? warnings : null })
  async function* run(): AsyncGenerator<Uint8Array> {
    let anyMatch = false
    let failed = false
    try {
      for (const p of paths.length > 0 ? paths : [STDIN_OPERAND]) {
        const [body, io] = await decompressInputs([p], read, {
          stdin: ctx.stdin,
          toStdout: true,
          force: true,
          quiet: true,
          ...(stat !== undefined ? { stat } : {}),
          resolver,
        })
        const selected = new IOResult({ exitCode: 1 })
        yield* streamInput(
          ensureStream(body ?? new Uint8Array()),
          stream,
          operandLabel(p, GREP_STDIN_LABEL),
          showFilename,
          selected,
          false,
          null,
          ctx.signal,
          true,
          p.rawPath,
        )
        anyMatch ||= selected.exitCode === 0
        failed ||= io.exitCode === 1 || selected.exitCode === 2
        const diagnostic = concat([
          await io.materializeStderr(),
          await selected.materializeStderr(),
        ])
        if (diagnostic.length)
          result.stderr = concat([await materialize(result.stderr), diagnostic])
        result.exitCode = exitCodeFor(anyMatch, failed, false)
      }
    } finally {
      await closeStream(stream)
    }
  }
  return [
    new OutputStream(run(), async () => {
      await closeStream(stream)
      await closeQuietly(ctx.stdin)
    }),
    result,
  ]
}
