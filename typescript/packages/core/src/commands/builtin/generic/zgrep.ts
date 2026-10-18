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

import { byteView, decodeText, encodeText, textView, utf8Locale } from '../../../shell/bytes.ts'
import { compilePosixRegex } from '../../../utils/posix.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import type { PathSpec, StatFn } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import {
  NEVER_MATCH,
  compilePattern,
  matcherSyntax,
  patternWarnings,
  resolvePattern,
} from '../grep_pattern.ts'
import { UsageError } from '../../errors.ts'
import type { RegexSyntax } from '../types.ts'
import { matchStart, matchText } from '../utils/pcre.ts'
import { GREP_STDIN_LABEL, STDIN_OPERAND } from '../utils/constants.ts'
import { linkResolver, mountRoot } from '../utils/links.ts'
import { operandLabel } from '../utils/stream.ts'
import { decompressInputs } from './decompress.ts'
import { listingMode, maxCount } from './grep.ts'
import { validUtf8 } from '../grep_binary.ts'
import { prefixOf } from '../grep_offsets.ts'
import { exitCodeFor } from '../grep_scan.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { OutputStream, closeQuietly } from '../../../io/stream.ts'

const ENC = new TextEncoder()

// Parsed zgrep flags; the complete set zgrep honors.
interface ZgrepFlags {
  readonly ignoreCase: boolean
  readonly invert: boolean
  readonly count: boolean
  readonly filesOnly: boolean
  readonly filesWithoutMatch: boolean
  readonly lineNumbers: boolean
  // -b: the byte offset of each line's start or, under -o, of the match
  // itself, in the field order GNU grep prints (name, line, byte). A line
  // is matched as its byte view, so its length is already its byte count.
  readonly byteOffsets: boolean
  readonly fixed: boolean
  readonly syntax: RegexSyntax
  readonly forceFilename: boolean
  readonly suppressFilename: boolean
  readonly onlyMatching: boolean
  readonly quiet: boolean
  readonly wholeWord: boolean
  readonly lineRegexp: boolean
  readonly maxCount: number | null
}

// The zero-pattern sentinel is a regex, so it suppresses -F.
function parseFlags(fl: FlagView, neverMatch: boolean): ZgrepFlags {
  const [filesOnly, filesWithoutMatch] = listingMode(fl)
  return {
    ignoreCase: fl.asBool('ignore_case'),
    invert: fl.asBool('invert_match'),
    count: fl.asBool('count'),
    filesOnly,
    filesWithoutMatch,
    lineNumbers: fl.asBool('line_number'),
    byteOffsets: fl.asBool('byte_offset'),
    fixed: fl.asBool('fixed_strings') && !neverMatch,
    // zgrep is grep over decompressed bytes, so it reads a basic expression
    // unless -E or -P says otherwise, and refuses two matchers as grep does;
    // -G asks for the default explicitly.
    syntax: matcherSyntax(fl),
    forceFilename: fl.asBool('with_filename'),
    suppressFilename: fl.asBool('no_filename'),
    onlyMatching: fl.asBool('only_matching'),
    quiet: fl.asBool('quiet'),
    wholeWord: fl.asBool('word_regexp'),
    lineRegexp: fl.asBool('line_regexp'),
    maxCount: maxCount(fl),
  }
}

export async function zgrepGeneric(
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  stat?: StatFn,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, specOf('zgrep'))
  const resolution = await resolvePattern('zgrep', texts, fl, paths, mountRoot(ctx), stream)
  if (resolution.error !== null) {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(resolution.error) })]
  }
  const neverMatch = resolution.neverMatch
  if (resolution.pattern === null) {
    return [
      null,
      new IOResult({
        exitCode: 2,
        stderr: ENC.encode('zgrep: usage: zgrep [flags] pattern [path]\n'),
      }),
    ]
  }
  const rawPattern = resolution.pattern
  let parsed: ZgrepFlags
  try {
    parsed = parseFlags(fl, neverMatch)
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(err.message + '\n') })]
  }
  const { syntax, fixed: fixedString, filesOnly, filesWithoutMatch, quiet, maxCount } = parsed
  const utf8 = utf8Locale(ctx.env)
  // GNU grep 3.11 skips regex validation and selection under -m0.
  const pattern =
    maxCount === 0
      ? null
      : neverMatch
        ? new RegExp(NEVER_MATCH)
        : compilePattern(
            byteView(rawPattern, utf8),
            parsed.ignoreCase,
            fixedString,
            parsed.wholeWord,
            syntax,
            utf8,
            parsed.lineRegexp,
          )

  const multi = paths.length > 1
  const showFilename = parsed.forceFilename || (multi && !parsed.suppressFilename)
  const resolver = linkResolver(ctx)
  const warnings =
    pattern === null || neverMatch || fixedString ? '' : patternWarnings(rawPattern, syntax)
  const result = new IOResult({
    exitCode: 1,
    stderr: warnings === '' ? null : encodeText(warnings),
  })
  const global =
    pattern !== null && parsed.onlyMatching
      ? compilePosixRegex(
          pattern.source,
          pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g',
        )
      : null
  async function* run(): AsyncGenerator<Uint8Array> {
    let anyMatch = false
    let failed = false
    for (const p of paths.length > 0 ? paths : [STDIN_OPERAND]) {
      const [body, io] = await decompressInputs([p], stream, {
        stdin: ctx.stdin,
        toStdout: true,
        force: true,
        quiet: true,
        ...(stat !== undefined ? { stat } : {}),
        resolver,
      })
      const reader = new AsyncLineIterator(body ?? new Uint8Array())
      let count = 0
      let number = 0
      let binary = false
      const fname = showFilename ? operandLabel(p, GREP_STDIN_LABEL) : null
      try {
        for (;;) {
          const offset = reader.position
          const raw = await reader.readline()
          if (raw === null) break
          number++
          // Keep reading after selection stops to validate the gzip trailer.
          if (
            pattern === null ||
            (maxCount !== null && count >= maxCount) ||
            ((filesOnly || filesWithoutMatch) && count > 0)
          )
            continue
          const line = byteView(raw, utf8)
          const selected: [number, string][] = []
          if (global !== null && !parsed.invert && !(filesOnly || filesWithoutMatch)) {
            global.lastIndex = 0
            let match: RegExpExecArray | null
            while ((match = global.exec(line)) !== null) {
              selected.push([matchStart(match), matchText(match)])
              if (match[0] === '')
                global.lastIndex += (line.codePointAt(match.index) ?? 0) > 0xffff ? 2 : 1
            }
          } else if (pattern.test(line) !== parsed.invert) selected.push([0, line])
          if (selected.length > 0) {
            count++
            anyMatch = true
          }
          for (const [at, text] of selected) {
            if (!(parsed.count || filesOnly || filesWithoutMatch || quiet)) {
              if (utf8 && !validUtf8(encodeText(text))) binary = true
              else {
                const byteAt = offset + (utf8 ? encodeText(line.slice(0, at)).length : at)
                const prefix =
                  (fname !== null ? fname + ':' : '') +
                  prefixOf(parsed.lineNumbers ? number : null, parsed.byteOffsets ? byteAt : null)
                yield encodeText(prefix + textView(text, utf8) + '\n')
              }
            }
          }
        }
      } finally {
        await reader.discard()
      }
      let diagnostic = decodeText(await io.materializeStderr())
      if (binary) diagnostic += `grep: ${operandLabel(p, GREP_STDIN_LABEL)}: binary file matches\n`
      if (diagnostic !== '')
        result.stderr = encodeText(decodeText(await materialize(result.stderr)) + diagnostic)
      failed ||= io.exitCode === 1
      result.exitCode = exitCodeFor(anyMatch, failed, false)
      if (pattern === null) {
        if (filesWithoutMatch) yield encodeText(p.rawPath + '\n')
      } else if (!quiet) {
        if (filesOnly || filesWithoutMatch) {
          if (count > 0 === filesOnly) yield encodeText(p.rawPath + '\n')
        } else if (parsed.count)
          yield encodeText((fname !== null ? fname + ':' : '') + String(count) + '\n')
      }
    }
  }
  return [new OutputStream(run(), () => closeQuietly(ctx.stdin)), result]
}
