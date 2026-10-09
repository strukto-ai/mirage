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
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
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
import { STDIN_OPERAND } from '../utils/constants.ts'
import { linkResolver } from '../utils/links.ts'
import { operandLabel } from '../utils/stream.ts'
import type { StatFn } from './archive/walk.ts'
import { decompressInputs } from './decompress.ts'
import { validUtf8 } from '../grep_binary.ts'
import { prefixOf } from '../grep_offsets.ts'
import { formatRecords } from '../utils/output.ts'
import { splitLines } from '../utils/lines.ts'

const ENC = new TextEncoder()

function anyLineSelected(
  data: Uint8Array,
  pattern: RegExp,
  invert: boolean,
  utf8: boolean,
): boolean {
  for (const line of splitLines(byteView(data, utf8))) {
    let hit = pattern.test(line)
    if (invert) hit = !hit
    if (hit) return true
  }
  return false
}

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
  // -l and -L set one mode in grep, so the later one on the line wins.
  let listing: string | null = null
  for (const name of fl.typedOrder('args_l', 'files_without_match')) {
    if (fl.asBool(name)) listing = name
  }
  return {
    ignoreCase: fl.asBool('i'),
    invert: fl.asBool('v'),
    count: fl.asBool('c'),
    filesOnly: listing === 'args_l',
    filesWithoutMatch: listing === 'files_without_match',
    lineNumbers: fl.asBool('n'),
    byteOffsets: fl.asBool('byte_offset'),
    fixed: fl.asBool('F') && !neverMatch,
    // zgrep is grep over decompressed bytes, so it reads a basic expression
    // unless -E or -P says otherwise, and refuses two matchers as grep does;
    // -G asks for the default explicitly.
    syntax: matcherSyntax(fl, 'grep', 'P'),
    forceFilename: fl.asBool('H'),
    suppressFilename: fl.asBool('h'),
    onlyMatching: fl.asBool('o'),
    quiet: fl.asBool('q'),
    wholeWord: fl.asBool('w'),
    lineRegexp: fl.asBool('line_regexp'),
    maxCount: fl.asInt('m') ?? null,
  }
}

function zgrepSearch(
  data: Uint8Array,
  pattern: RegExp,
  opts: ZgrepFlags,
  filename: string | null,
  utf8: boolean,
): [string[], boolean, boolean] {
  const reGlobal = opts.onlyMatching
    ? compilePosixRegex(
        pattern.source,
        pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g',
      )
    : null
  const matched: [number, number, string][] = []
  let start = 0
  const bytesOf = (view: string): number => (utf8 ? encodeText(view).length : view.length)
  for (const [i, line] of splitLines(byteView(data, utf8)).entries()) {
    if (opts.onlyMatching && !opts.invert && reGlobal !== null) {
      reGlobal.lastIndex = 0
      let m: RegExpExecArray | null
      const hits: RegExpExecArray[] = []
      while ((m = reGlobal.exec(line)) !== null) {
        hits.push(m)
        if (m[0] === '') reGlobal.lastIndex += (line.codePointAt(m.index) ?? 0) > 0xffff ? 2 : 1
      }
      if (hits.length > 0) {
        for (const h of hits) {
          matched.push([i + 1, start + bytesOf(line.slice(0, matchStart(h))), matchText(h)])
          if (opts.maxCount !== null && matched.length >= opts.maxCount) break
        }
      }
    } else {
      let hit = pattern.test(line)
      if (opts.invert) hit = !hit
      if (hit) matched.push([i + 1, start, line])
    }
    if (opts.maxCount !== null && matched.length >= opts.maxCount) break
    start += bytesOf(line) + 1
  }
  if (opts.count) {
    const value =
      filename !== null ? `${filename}:${String(matched.length)}` : String(matched.length)
    return [[value], matched.length > 0, false]
  }
  // Under a UTF-8 locale a line or match to print that holds a byte no
  // character owns is binary output, which grep leaves out and reports once
  // the input is done; the third value says whether any was.
  const result: string[] = []
  let binary = false
  for (const [idx, offset, line] of matched) {
    if (utf8 && !validUtf8(encodeText(line))) {
      binary = true
      continue
    }
    let prefix = ''
    if (filename !== null) prefix = filename + ':'
    prefix += prefixOf(opts.lineNumbers ? idx : null, opts.byteOffsets ? offset : null)
    result.push(prefix + textView(line, utf8))
  }
  return [result, matched.length > 0, binary]
}

export async function zgrepGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  stat?: StatFn,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('zgrep'))
  const resolution = await resolvePattern(
    'zgrep',
    texts,
    opts.flags,
    paths,
    opts.mountPrefix,
    stream,
  )
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
  const {
    syntax,
    fixed: fixedString,
    invert,
    filesOnly,
    filesWithoutMatch,
    quiet,
    maxCount,
  } = parsed
  const utf8 = utf8Locale(opts.env)
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
  let anyMatch = false
  const allResults: string[] = []

  const resolver = linkResolver(opts)
  // zgrep runs grep, so grep's compile warnings come first, in its name.
  let errors =
    pattern === null || neverMatch || fixedString ? '' : patternWarnings(rawPattern, syntax)
  let failed = false
  for (const p of paths.length > 0 ? paths : [STDIN_OPERAND]) {
    // zgrep decompresses each operand with `gzip -cdfq -- FILE`, which
    // reports its own failures and hands grep what it decoded.
    const [body, io] = await decompressInputs([p], stream, {
      stdin: opts.stdin,
      toStdout: true,
      force: true,
      quiet: true,
      ...(stat !== undefined ? { stat } : {}),
      resolver,
    })
    const data = await materialize(body)
    errors += decodeText(await io.materializeStderr())
    failed ||= io.exitCode === 1
    if (pattern === null) {
      if (filesWithoutMatch) allResults.push(p.rawPath)
      continue
    }
    // zgrep hands grep a stdin operand as `-`, so -l and -L list it as `-`
    // while its lines are labelled `(standard input)` (gzip 1.13);
    // /dev/stdin is named as typed either way.
    const fname = showFilename ? operandLabel(p, '(standard input)') : null
    if (filesOnly || filesWithoutMatch) {
      // -L lists the files that selected nothing; the status still
      // follows the matching, as GNU grep's does.
      const matched = anyLineSelected(data, pattern, invert, utf8)
      if (matched === filesOnly) allResults.push(p.rawPath)
      anyMatch ||= matched
    } else {
      const [result, hadMatch, binary] = zgrepSearch(data, pattern, parsed, fname, utf8)
      if (hadMatch) anyMatch = true
      for (const r of result) allResults.push(r)
      if (binary && !quiet)
        errors += `grep: ${operandLabel(p, '(standard input)')}: binary file matches\n`
    }
  }

  // gzip's failure is exit 2 even beside a match, -q included (zgrep 1.13
  // takes the more serious status of gzip's and grep's per file).
  const exitCode = failed ? 2 : anyMatch ? 0 : 1
  const stderr = errors === '' ? null : encodeText(errors)
  // Under -m0, GNU still prints -L's operands even with -q.
  if ((quiet && maxCount !== 0) || allResults.length === 0)
    return [null, new IOResult({ exitCode, stderr })]
  const result: ByteSource = formatRecords(allResults)
  return [result, new IOResult({ exitCode, stderr })]
}
