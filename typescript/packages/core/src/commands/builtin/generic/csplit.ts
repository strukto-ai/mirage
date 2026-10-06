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
import { CommandName } from '../../spec/types.ts'
import { missingOperandError } from '../../spec/usage.ts'
import { fsStrerror, isFsError } from '../../../utils/errors.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { resolvePath, typedSpec } from '../../../utils/path.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { splitLines } from '../utils/lines.ts'

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
function splitByPatterns(
  lines: readonly string[],
  patterns: readonly string[],
  suppressMatched: boolean,
): [string[][], string | null] {
  const parts: string[][] = []
  let head = 0
  let seen = 0
  for (const pat of patterns) {
    const outOfRange = `csplit: '${pat}': line number out of range\n`
    if (isRegex(pat)) {
      const regex = new RegExp(pat.slice(1, -1))
      let found = -1
      for (let idx = seen; idx < lines.length; idx++) {
        if (regex.test(lines[idx] ?? '')) {
          found = idx
          break
        }
      }
      if (found === -1) {
        parts.push(lines.slice(head))
        return [parts, `csplit: '${pat}': match not found\n`]
      }
      parts.push(lines.slice(head, found))
      head = found
      seen = found + 1
    } else {
      if (suppressMatched && seen >= lines.length) {
        parts.push([])
        return [parts, outOfRange]
      }
      const stop = Math.max(head, Number.parseInt(pat, 10) - 1)
      if (stop > lines.length) {
        parts.push(lines.slice(head))
        return [parts, outOfRange]
      }
      parts.push(lines.slice(head, stop))
      head = stop
      seen = Math.max(seen, stop)
      if (!suppressMatched && seen >= lines.length) return [parts, outOfRange]
    }
    if (suppressMatched && head < lines.length) {
      head += 1
      seen = Math.max(seen, head)
    }
  }
  parts.push(lines.slice(head))
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
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
  unlink: (p: PathSpec) => Promise<void>,
  relay = false,
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
  const prefixSpec = fl.asPath('prefix')
  const prefixWord = prefixSpec?.rawPath ?? 'xx'
  const prefixVirtual = prefixSpec?.virtual ?? resolvePath(prefixWord, opts.cwd)
  const typedPrefix = prefixSpec?.rawPath ?? prefixWord
  const mountPrefix = opts.mountPrefix ?? ''
  const digitsValue = fl.asStr('digits')
  const suffixValue = fl.asStr('suffix_format')
  const digits = typeof digitsValue === 'string' ? Number.parseInt(digitsValue, 10) : 2
  const suffixFormat = typeof suffixValue === 'string' ? suffixValue : null
  const quiet = fl.asBool('quiet') || fl.asBool('silent')
  const keep = fl.asBool('keep_files')
  const suppressMatched = fl.asBool('suppress_matched')
  const elideEmpty = fl.asBool('elide_empty_files')
  let raw: Uint8Array
  // `-` is stdin. /dev/stdin would run csplit on the /dev mount, which is
  // where its pieces would land, so it stays a path.
  const first = paths[0]
  if (first !== undefined && first.rawPath !== '-') {
    raw = await materialize(stream(first))
  } else {
    const stdinData = await readStdinAsync(opts.stdin)
    raw = stdinData ?? new Uint8Array(0)
  }
  const checked = checkLineNumbers(texts)
  let diagnostics = checked[0]
  if (checked[1]) {
    return [ENC.encode(''), new IOResult({ stderr: ENC.encode(diagnostics), exitCode: 1 })]
  }
  const text = DEC.decode(raw)
  const lines = splitLines(text)
  const [parts, splitError] = splitByPatterns(lines, texts, suppressMatched)
  let error = splitError
  const writes: Record<string, Uint8Array> = {}
  const sizes: string[] = []
  const created: [string, PathSpec][] = []
  for (const part of parts) {
    if (elideEmpty && part.length === 0) continue
    const suffix = formatSuffix(sizes.length, digits, suffixFormat)
    const name = typedPrefix + suffix
    const data = part.length > 0 ? ENC.encode(part.join('\n') + '\n') : new Uint8Array(0)
    const virtual = prefixVirtual + suffix
    const scope = typedSpec((prefixSpec?.dotted ?? prefixVirtual) + suffix, '/')
    const spec = new PathSpec({
      virtual: scope.virtual,
      directory: scope.directory,
      dotted: scope.dotted,
      walkError: scope.walkError,
      vfsPath: mountKey(virtual, mountPrefix),
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
    // Relay writes land on whichever mount owns each path and invalidate
    // through the dispatcher; keying them here would have the runner prefix
    // them onto this mount.
    if (!relay) writes[spec.mountPath] = data
    sizes.push(String(data.byteLength))
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
      writes,
      ...(diagnostics !== '' ? { stderr: ENC.encode(diagnostics) } : {}),
      ...(error !== null ? { exitCode: 1 } : {}),
    }),
  ]
}
