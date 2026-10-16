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

import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { RecordSpool } from '../../../io/record_spool.ts'

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { CommandName } from '../../spec/types.ts'
import { missingOperandError } from '../../spec/usage.ts'
import { fsStrerror, isFsError } from '../../../errors/fs.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function isRegex(pattern: string): boolean {
  return pattern.startsWith('/') && pattern.endsWith('/')
}

/**
 * GNU's parse-time checks on the line-number patterns, in order: a repeated
 * number warns and still splits (an empty piece); a zero or a number below
 * its predecessor refuses the whole run before any piece is written.
 * Mirrors Python's `_check_line_numbers`.
 */
function checkLineNumbers(patterns: readonly string[]): [string, boolean] {
  let messages = ''
  let last = 0
  for (const pattern of patterns) {
    if (isRegex(pattern)) continue
    const number = Number.parseInt(pattern, 10)
    if (number <= 0) {
      return [messages + `csplit: ${pattern}: line number must be greater than zero\n`, true]
    }
    if (number < last) {
      const refusal = `csplit: line number '${pattern}' is smaller than preceding line number, ${String(last)}\n`
      return [messages + refusal, true]
    }
    if (number === last) {
      messages += `csplit: warning: line number '${pattern}' is the same as preceding line number\n`
    }
    last = number
  }
  return [messages, false]
}

/**
 * Cut `lines` into pieces as GNU csplit does, and report a failure. GNU keeps
 * two cursors: the first line not yet written (`head`) and the last line it
 * examined (`seen`, counted from 1). A regex searches from the line after
 * `seen`, so a repeated regex never matches the line the previous one stopped
 * at; line N writes up to the line before it, an empty piece once `head` is
 * past it. A line number fails when no line follows `seen`, a regex when
 * nothing matches, and the piece being built takes what is left.
 * `--suppress-matched` drops the line each pattern stops at. The rest of the
 * input is always the last piece, empty or not. Mirrors Python's
 * `_split_by_patterns`.
 */
async function splitByPatterns(
  lines: RecordSpool,
  patterns: readonly string[],
  suppressMatched: boolean,
): Promise<[[number, number][], string | null]> {
  const parts: [number, number][] = []
  let head = 0
  let seen = 0
  for (const pat of patterns) {
    const outOfRange = `csplit: '${pat}': line number out of range\n`
    if (isRegex(pat)) {
      const regex = new RegExp(pat.slice(1, -1))
      let found = -1
      for (let idx = seen; idx < lines.count; idx++) {
        if (regex.test(DEC.decode(await lines.read(idx)).slice(0, -1))) {
          found = idx
          break
        }
      }
      if (found === -1) {
        parts.push([head, lines.count])
        return [parts, `csplit: '${pat}': match not found\n`]
      }
      parts.push([head, found])
      head = found
      seen = found + 1
    } else {
      if (suppressMatched && seen >= lines.count) {
        parts.push([head, head])
        return [parts, outOfRange]
      }
      const stop = Math.max(head, Number.parseInt(pat, 10) - 1)
      if (stop > lines.count) {
        parts.push([head, lines.count])
        return [parts, outOfRange]
      }
      parts.push([head, stop])
      head = stop
      seen = Math.max(seen, stop)
      if (!suppressMatched && seen >= lines.count) return [parts, outOfRange]
    }
    if (suppressMatched && head < lines.count) {
      head += 1
      seen = Math.max(seen, head)
    }
  }
  parts.push([head, lines.count])
  return [parts, null]
}

function padNum(n: number, digits: number): string {
  const s = String(n)
  return s.length >= digits ? s : '0'.repeat(digits - s.length) + s
}

function formatSuffix(index: number, digits: number, format: string | null): string {
  if (format === null) return padNum(index, digits)
  return format.replace(/%0?(\d*)([doxX])/, (_match, widthRaw: string, kind: string) => {
    const width = widthRaw === '' ? 0 : Number.parseInt(widthRaw, 10)
    const radix = kind === 'o' ? 8 : kind === 'x' || kind === 'X' ? 16 : 10
    let value = index.toString(radix)
    if (kind === 'X') value = value.toUpperCase()
    return value.padStart(width, '0')
  })
}

export async function csplitGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: ByteSource) => Promise<void>,
  unlink: (p: PathSpec) => Promise<void>,
): Promise<CommandFnResult> {
  // GNU wants FILE and a PATTERN before it opens anything.
  if (texts.length === 0) {
    throw missingOperandError(CommandName.CSPLIT, paths[paths.length - 1]?.rawPath ?? null)
  }
  const fl = new FlagView(opts.flags, specOf('csplit'))
  // An output is the -f prefix, or `xx` in the working directory, plus its
  // suffix, wherever the input lives: GNU writes `xx00` to the cwd, names it
  // as it formed it (`csplit: xx00`), and stops at the first one it cannot
  // create, -k or not. Mirrors csplit.py.
  const typedPrefix = fl.asPath('prefix')?.rawPath ?? 'xx'
  const mountPrefix = opts.mountPrefix ?? ''
  const digitsValue = fl.asStr('digits')
  const suffixValue = fl.asStr('suffix_format')
  const digits = typeof digitsValue === 'string' ? Number.parseInt(digitsValue, 10) : 2
  const suffixFormat = typeof suffixValue === 'string' ? suffixValue : null
  const quiet = fl.asBool('quiet') || fl.asBool('silent')
  const keep = fl.asBool('keep_files')
  const suppressMatched = fl.asBool('suppress_matched')
  const elideEmpty = fl.asBool('elide_empty_files')
  const first = paths[0]
  const source =
    first !== undefined && first.rawPath !== '-' ? stream(first) : (opts.stdin ?? new Uint8Array())
  const records = new RecordSpool()
  const reader = new AsyncLineIterator(source)
  try {
    for await (const line of reader) await records.append(ENC.encode(DEC.decode(line) + '\n'))
    const checked = checkLineNumbers(texts)
    let diagnostics = checked[0]
    if (checked[1])
      return [new Uint8Array(), new IOResult({ stderr: ENC.encode(diagnostics), exitCode: 1 })]
    const [parts, splitError] = await splitByPatterns(records, texts, suppressMatched)
    let error = splitError
    const sizes: string[] = []
    const created: [string, PathSpec][] = []
    for (const [first, last] of parts) {
      if (elideEmpty && first === last) continue
      const suffix = formatSuffix(sizes.length, digits, suffixFormat)
      const name = typedPrefix + suffix
      const start = first < records.count ? (await records.window(first))[0] : records.data.size
      const end = last < records.count ? (await records.window(last))[0] : records.data.size
      const size = end - start
      const data = records.data.stream(start, size)
      const scope = PathSpec.fromStrPath(name, undefined, opts.cwd)
      const spec = new PathSpec({
        virtual: scope.virtual,
        directory: scope.directory,
        dotted: scope.dotted,
        walkError: scope.walkError,
        vfsPath: mountKey(scope.virtual, mountPrefix),
        rawPath: name,
      })
      try {
        await write(spec, data)
      } catch (err) {
        if (!isFsError(err)) throw err
        error = `csplit: ${name}: ${String(fsStrerror(err))}\n`
        break
      }
      created.push([name, spec])
      sizes.push(String(size))
    }
    if (error !== null) diagnostics += error
    if (error !== null && !keep) {
      // GNU removes every piece the failed run wrote unless -k keeps them, so
      // an earlier run's piece of that name is gone too.
      for (const [name, spec] of created) {
        try {
          await unlink(spec)
        } catch (err) {
          if (!isFsError(err)) throw err
          diagnostics += `csplit: ${name}: ${String(fsStrerror(err))}\n`
        }
      }
    }
    const output = quiet || sizes.length === 0 ? '' : sizes.join('\n') + '\n'
    const result: ByteSource = ENC.encode(output)
    return [
      result,
      new IOResult({
        ...(diagnostics !== '' ? { stderr: ENC.encode(diagnostics) } : {}),
        ...(error !== null ? { exitCode: 1 } : {}),
      }),
    ]
  } finally {
    try {
      await reader.discard()
    } finally {
      await records.close()
    }
  }
}
