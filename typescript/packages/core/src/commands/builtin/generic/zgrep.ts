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
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { gunzip } from '../../../utils/compress.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { compilePattern, resolvePattern } from '../grep_pattern.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { decodeLine, lineOffsets, matchOffset, prefixOf } from '../grep_offsets.ts'
import { formatRecords } from '../utils/output.ts'
import { splitLines } from '../utils/lines.ts'

const ENC = new TextEncoder()

// zgrep's hint takes the backtick form rather than the
// `Try '... --help' for more information.` line usageHint builds, so it
// is a constant here rather than a call. A host zgrep prefixes a script
// line number and an interpreter path; both are dropped, since they
// name a file mirage does not have.
const ZGREP_NO_PATTERN = "zgrep: missing pattern; try `zgrep --help' for help"

function anyLineSelected(data: Uint8Array, pattern: RegExp, invert: boolean): boolean {
  for (const line of splitLines(decodeLine(data))) {
    let hit = pattern.test(line)
    if (invert) hit = !hit
    if (hit) return true
  }
  return false
}

interface ZgrepOpts {
  ignoreCase: boolean
  invert: boolean
  count: boolean
  lineNumbers: boolean
  onlyMatching: boolean
  maxCount: number | null
  // -b: the byte offset of each line's start or, under -o, of the match
  // itself, in the field order GNU grep prints (name, line, byte).
  byteOffsets: boolean
}

function zgrepSearch(
  data: Uint8Array,
  pattern: RegExp,
  opts: ZgrepOpts,
  filename: string | null,
): [string[], boolean] {
  const lines = splitLines(decodeLine(data))
  const offsets = opts.byteOffsets ? lineOffsets(lines) : []
  const reGlobal = opts.onlyMatching
    ? new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
    : null
  const matched: [number, number, string][] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const start = opts.byteOffsets ? (offsets[i] ?? 0) : 0
    if (opts.onlyMatching && !opts.invert && reGlobal !== null) {
      reGlobal.lastIndex = 0
      let m: RegExpExecArray | null
      const hits: RegExpExecArray[] = []
      while ((m = reGlobal.exec(line)) !== null) {
        hits.push(m)
        if (m[0] === '') reGlobal.lastIndex += 1
      }
      if (hits.length > 0) {
        for (const h of hits) {
          matched.push([i + 1, matchOffset(start, line, h.index), h[0]])
          if (opts.maxCount !== null && matched.length >= opts.maxCount) break
        }
      }
    } else {
      let hit = pattern.test(line)
      if (opts.invert) hit = !hit
      if (hit) matched.push([i + 1, start, line])
    }
    if (opts.maxCount !== null && matched.length >= opts.maxCount) break
  }
  if (opts.count) {
    const value =
      filename !== null ? `${filename}:${String(matched.length)}` : String(matched.length)
    return [[value], matched.length > 0]
  }
  const result: string[] = []
  for (const [idx, offset, line] of matched) {
    let prefix = ''
    if (filename !== null) prefix = filename + ':'
    prefix += prefixOf(opts.lineNumbers ? idx : null, opts.byteOffsets ? offset : null)
    result.push(prefix + line)
  }
  return [result, matched.length > 0]
}

export async function zgrepGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
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
    return [null, new IOResult({ exitCode: 2, stderr: new TextEncoder().encode(resolution.error) })]
  }
  const neverMatch = resolution.neverMatch
  if (resolution.pattern === null) {
    return [
      null,
      new IOResult({
        exitCode: 2,
        stderr: ENC.encode(`${ZGREP_NO_PATTERN}\n`),
      }),
    ]
  }
  const rawPattern = resolution.pattern
  // zgrep is grep over decompressed bytes, so it reads a basic expression
  // unless -E says otherwise; -G asks for the default explicitly.
  const basicRegexp = !fl.asBool('E')
  const fixedString = fl.asBool('F') && !neverMatch
  const wholeWord = fl.asBool('w')
  const ignoreCase = fl.asBool('i')
  const invert = fl.asBool('v')
  const countOnly = fl.asBool('c')
  const lineNumbers = fl.asBool('n')
  const onlyMatching = fl.asBool('o')
  const quiet = fl.asBool('q')
  const byteOffsets = fl.asBool('byte_offset')
  // -l and -L set one mode in grep, so the later one on the line wins.
  let listing: string | null = null
  for (const name of fl.typedOrder('args_l', 'files_without_match')) {
    if (fl.asBool(name)) listing = name
  }
  const filesOnly = listing === 'args_l'
  const filesWithoutMatch = listing === 'files_without_match'
  const forceH = fl.asBool('H')
  const hideH = fl.asBool('h')
  const maxCount = fl.asInt('m') ?? null
  const pattern = compilePattern(rawPattern, ignoreCase, fixedString, wholeWord, basicRegexp)

  const multi = paths.length > 1
  const showFilename = forceH || (multi && !hideH)
  let anyMatch = false
  const allResults: string[] = []

  if (paths.length > 0) {
    for (const p of paths) {
      const compressed = await materialize(stream(p))
      const data = await gunzip(compressed)
      const fname = showFilename ? p.rawPath : null
      if (filesOnly || filesWithoutMatch) {
        // -L lists the files that selected nothing; the status still
        // follows the matching, as GNU grep's does. -m0 selects no line at
        // all, so -l lists nothing and -L lists every archive, exit 1
        // (zgrep 3.11).
        const matched = maxCount !== 0 && anyLineSelected(data, pattern, invert)
        if (matched === filesOnly) allResults.push(p.rawPath)
        anyMatch ||= matched
      } else {
        const [result, hadMatch] = zgrepSearch(
          data,
          pattern,
          {
            ignoreCase,
            invert,
            count: countOnly,
            lineNumbers,
            onlyMatching,
            maxCount,
            byteOffsets,
          },
          fname,
        )
        if (hadMatch) anyMatch = true
        for (const r of result) allResults.push(r)
      }
    }
  } else {
    const stdinData = await readStdinAsync(opts.stdin)
    const data =
      stdinData === null || stdinData.byteLength === 0 ? new Uint8Array(0) : await gunzip(stdinData)
    if (filesOnly || filesWithoutMatch) {
      const matched = maxCount !== 0 && anyLineSelected(data, pattern, invert)
      if (matched === filesOnly) allResults.push('(standard input)')
      anyMatch ||= matched
    } else {
      // GNU zgrep labels stdin "(standard input)" under -H.
      const [result, hadMatch] = zgrepSearch(
        data,
        pattern,
        { ignoreCase, invert, count: countOnly, lineNumbers, onlyMatching, maxCount, byteOffsets },
        forceH ? '(standard input)' : null,
      )
      if (hadMatch) anyMatch = true
      for (const r of result) allResults.push(r)
    }
  }

  if (quiet) return [null, new IOResult({ exitCode: anyMatch ? 0 : 1 })]
  const exitCode = anyMatch ? 0 : 1
  if (allResults.length === 0) return [null, new IOResult({ exitCode })]
  const result: ByteSource = formatRecords(allResults)
  return [result, new IOResult({ exitCode })]
}
