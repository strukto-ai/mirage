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

import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { gunzip } from '../../../utils/compress.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { compilePattern, resolvePatternFromFlags } from '../grep_helper.ts'
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function splitLinesNoTrailing(text: string): string[] {
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  return stripped === '' ? [] : stripped.split('\n')
}

interface ZgrepOpts {
  ignoreCase: boolean
  invert: boolean
  count: boolean
  lineNumbers: boolean
  onlyMatching: boolean
  maxCount: number | null
}

function zgrepSearch(
  data: Uint8Array,
  pattern: RegExp,
  opts: ZgrepOpts,
  filename: string | null,
): [string[], boolean] {
  const text = DEC.decode(data)
  const lines = splitLinesNoTrailing(text)
  const reGlobal = opts.onlyMatching
    ? new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
    : null
  const matched: [number, string][] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
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
          matched.push([i + 1, h[0]])
          if (opts.maxCount !== null && matched.length >= opts.maxCount) break
        }
      }
    } else {
      let hit = pattern.test(line)
      if (opts.invert) hit = !hit
      if (hit) matched.push([i + 1, line])
    }
    if (opts.maxCount !== null && matched.length >= opts.maxCount) break
  }
  if (opts.count) {
    const value =
      filename !== null ? `${filename}:${String(matched.length)}` : String(matched.length)
    return [[value], matched.length > 0]
  }
  const result: string[] = []
  for (const [idx, line] of matched) {
    let prefix = ''
    if (filename !== null) prefix = filename + ':'
    if (opts.lineNumbers) prefix += String(idx) + ':'
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
  const resolution = await resolvePatternFromFlags(
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
        stderr: ENC.encode('zgrep: usage: zgrep [flags] pattern [path]\n'),
      }),
    ]
  }
  const rawPattern = resolution.pattern
  const extendedRegex = opts.flags.E === true
  const fixedString = opts.flags.F === true && !neverMatch
  const wholeWord = opts.flags.w === true
  const ignoreCase = opts.flags.i === true
  const invert = opts.flags.v === true
  const countOnly = opts.flags.c === true
  const lineNumbers = opts.flags.n === true
  const onlyMatching = opts.flags.o === true
  const quiet = opts.flags.q === true
  const filesOnly = opts.flags.args_l === true
  const forceH = opts.flags.H === true
  const hideH = opts.flags.h === true
  const maxCount = typeof opts.flags.m === 'string' ? Number.parseInt(opts.flags.m, 10) : null
  void extendedRegex
  const pattern = compilePattern(rawPattern, ignoreCase, fixedString, wholeWord)

  const multi = paths.length > 1
  const showFilename = forceH || (multi && !hideH)
  let anyMatch = false
  const allResults: string[] = []

  if (paths.length > 0) {
    for (const p of paths) {
      const compressed = await materialize(stream(p))
      const data = await gunzip(compressed)
      const fname = showFilename ? p.virtual : null
      if (filesOnly) {
        const text = DEC.decode(data)
        const lines = splitLinesNoTrailing(text)
        for (const line of lines) {
          let hit = pattern.test(line)
          if (invert) hit = !hit
          if (hit) {
            allResults.push(p.virtual)
            anyMatch = true
            break
          }
        }
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
    if (filesOnly) {
      const text = DEC.decode(data)
      const lines = splitLinesNoTrailing(text)
      for (const line of lines) {
        let hit = pattern.test(line)
        if (invert) hit = !hit
        if (hit) {
          allResults.push('(standard input)')
          anyMatch = true
          break
        }
      }
    } else {
      // GNU zgrep labels stdin "(standard input)" under -H.
      const [result, hadMatch] = zgrepSearch(
        data,
        pattern,
        { ignoreCase, invert, count: countOnly, lineNumbers, onlyMatching, maxCount },
        forceH ? '(standard input)' : null,
      )
      if (hadMatch) anyMatch = true
      for (const r of result) allResults.push(r)
    }
  }

  if (quiet) return [null, new IOResult({ exitCode: anyMatch ? 0 : 1 })]
  const exitCode = anyMatch ? 0 : 1
  if (allResults.length === 0) return [null, new IOResult({ exitCode })]
  const result: ByteSource = ENC.encode(allResults.join('\n') + '\n')
  return [result, new IOResult({ exitCode })]
}
