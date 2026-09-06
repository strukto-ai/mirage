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

import { SHELL_SPECS, parseShellOptions } from '../../../../commands/spec/shell.ts'
import { AsyncLineIterator } from '../../../../io/async_line_iterator.ts'
import { asyncChain } from '../../../../io/stream.ts'
import { IOResult } from '../../../../io/types.ts'
import type { ByteSource } from '../../../../io/types.ts'
import { ArithError } from '../../../../shell/errors.ts'
import { isFsError } from '../../../../utils/errors.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import { assignElement } from '../../../session/elements.ts'
import type { Session } from '../../../session/session.ts'
import { visibleEnv } from '../../../session/state.ts'
import type { SessionView } from '../../../../ops/types.ts'
import { ExecutionNode } from '../../../types.ts'
import { arithRefusal, isValidName, readonlyRefusal, refusal, requireView } from '../shared.ts'
import { TARGET_RE } from '../constants.ts'
import { READ_VALUE_LETTERS } from './constants.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { sessionView } from '../../../session/state.ts'

/** Split on whitespace runs with a maxsplit, like Python's split(None, n). */
function splitOnWhitespace(text: string, maxsplit: number): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    while (i < text.length && /[ \t\n]/.test(text[i] ?? '')) i++
    if (i >= text.length) break
    if (out.length === maxsplit) {
      out.push(text.slice(i))
      return out
    }
    let j = i
    while (j < text.length && !/[ \t\n]/.test(text[j] ?? '')) j++
    out.push(text.slice(i, j))
    i = j
  }
  return out
}

function readRefusal(msg: string): Result {
  const err = new TextEncoder().encode(msg)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: err }),
    new ExecutionNode({ command: 'read', exitCode: 1, stderr: err }),
  ]
}

function readCount(text: string): number | null {
  return /^[0-9]+$/.test(text) ? parseInt(text, 10) : null
}

function readTimeout(text: string): number | null {
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 ? value : null
}

/** Which of `-n`/`-N` was written last, since bash keeps only one. */
function lastCountFlag(args: string[]): string | null {
  let which: string | null = null
  let i = 0
  while (i < args.length) {
    const tok = args[i] ?? ''
    if (tok === '--' || !tok.startsWith('-') || tok === '-') break
    let j = 1
    while (j < tok.length) {
      const ch = tok[j] ?? ''
      if (ch === 'n' || ch === 'N') which = ch
      if (READ_VALUE_LETTERS.has(ch)) {
        if (j === tok.length - 1) i++
        break
      }
      j++
    }
    i++
  }
  return which
}

function splitReadLine(line: string, ifs: string, slots: number): string[] {
  if (ifs === ' \t\n') {
    const trimmed = line.replace(/^[ \t\n]+|[ \t\n]+$/g, '')
    if (slots === 0) return trimmed === '' ? [] : trimmed.split(/[ \t\n]+/)
    return splitOnWhitespace(trimmed, slots - 1)
  }
  if (ifs === '') return [line]
  const ifsWs = new Set<string>(ifs.split('').filter((c) => c === ' ' || c === '\t' || c === '\n'))
  let start = 0
  let end = line.length
  while (start < end && ifsWs.has(line[start] ?? '')) start++
  while (end > start && ifsWs.has(line[end - 1] ?? '')) end--
  const work = line.slice(start, end)
  const nSplits = slots === 0 ? work.length : Math.max(0, slots - 1)
  const chars = new Set(ifs.split(''))
  const out: string[] = []
  let cur = ''
  for (const ch of work) {
    if (chars.has(ch) && out.length < nSplits) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out
}

/** read's default backslash handling: a backslash quotes the next
 * character and a backslash-newline pair is a line continuation. */
function unescapeRead(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text.charAt(i)
    if (ch === '\\' && i + 1 < text.length) {
      const nxt = text.charAt(i + 1)
      if (nxt !== '\n') out += nxt
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

async function readRaw(
  buffer: AsyncLineIterator,
  raw: boolean,
  delim: number,
  nchars: number | null,
  exact: number | null,
): Promise<[string, boolean]> {
  const dec = new TextDecoder()
  if (exact !== null) {
    const [data, complete] = await buffer.readChars(exact, null)
    return [dec.decode(data), complete]
  }
  if (nchars !== null) {
    let [data, complete] = await buffer.readChars(nchars, delim)
    let text = dec.decode(data)
    while (
      !raw &&
      complete &&
      text.endsWith('\\') &&
      (text.length - text.replace(/\\+$/, '').length) % 2 === 1 &&
      text.length < nchars
    ) {
      ;[data, complete] = await buffer.readChars(nchars - text.length, delim)
      text += dec.decode(data)
    }
    return [text, complete]
  }
  let [data, complete] = await buffer.readUntil(delim)
  let text = dec.decode(data)
  while (
    !raw &&
    complete &&
    delim === 10 &&
    (text.length - text.replace(/\\+$/, '').length) % 2 === 1
  ) {
    ;[data, complete] = await buffer.readUntil(delim)
    text += '\n' + dec.decode(data)
  }
  return [text, complete]
}

/**
 * Read one line (or delimited record, or character count) into
 * variables, with bash's option surface. `-r` turns off backslash
 * processing; `-d C` reads to `C`; `-n N`/`-N N` bound the read; `-a
 * NAME` stores fields in an array; `-t` accepts a timeout (0 answers
 * whether a source is present); `-p -s -e -i` are non-tty no-ops; `-u
 * 0` is this shell's input and any other descriptor is refused. The
 * status is 1 when end of input ended the read.
 */
export async function handleRead(
  args: string[],
  session: Session,
  stdin: ByteSource | null,
  state: SessionView | null = null,
): Promise<Result> {
  const parse = parseShellOptions(SHELL_SPECS.read, args)
  if (parse.invalid !== null) {
    const token = parse.invalid.startsWith('--') ? parse.invalid : `-${parse.invalid}`
    const err = new TextEncoder().encode(`read: ${token}: invalid option\n`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'read', exitCode: 2 }),
    ]
  }
  if (parse.needsValue !== null) {
    const err = new TextEncoder().encode(
      `read: -${parse.needsValue}: option requires an argument\n`,
    )
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'read', exitCode: 2 }),
    ]
  }
  const flags = parse.flags
  const raw = flags.r === true
  let delim = 10
  if (typeof flags.d === 'string') {
    delim = flags.d.length > 0 ? flags.d.charCodeAt(0) : 0
  }
  for (const key of ['n', 'N'] as const) {
    if (typeof flags[key] === 'string' && readCount(flags[key]) === null) {
      return readRefusal(`bash: read: ${flags[key]}: invalid number\n`)
    }
  }
  let nchars: number | null = null
  let exact: number | null = null
  const which = lastCountFlag(args)
  if (which === 'N') exact = readCount(String(flags.N))
  else if (which === 'n') nchars = readCount(String(flags.n))
  let timeout: number | null = null
  if (typeof flags.t === 'string') {
    timeout = readTimeout(flags.t)
    if (timeout === null) {
      return readRefusal(`bash: read: ${flags.t}: invalid timeout specification\n`)
    }
  }
  if (typeof flags.u === 'string' && flags.u !== '0') {
    return readRefusal(`bash: read: ${flags.u}: invalid file descriptor: Bad file descriptor\n`)
  }
  const arrayName = typeof flags.a === 'string' ? flags.a : null
  if (arrayName !== null && !isValidName(arrayName)) {
    return readRefusal(`bash: read: \`${arrayName}': not a valid identifier\n`)
  }
  const variables = parse.operands.length > 0 ? parse.operands : ['REPLY']
  if (stdin !== null && (session.stdinBuffer === null || session.stdinSource !== stdin)) {
    if (stdin instanceof Uint8Array) {
      session.stdinBuffer = new AsyncLineIterator(asyncChain(stdin))
    } else {
      session.stdinBuffer = new AsyncLineIterator(stdin)
    }
    session.stdinSource = stdin
  }
  const view = requireView(state)
  const buffer = session.stdinBuffer
  if (timeout === 0) {
    const code = buffer !== null ? 0 : 1
    return [
      null,
      new IOResult({ exitCode: code }),
      new ExecutionNode({ command: 'read', exitCode: code }),
    ]
  }
  let complete = false
  let line = ''
  if (buffer !== null) {
    try {
      ;[line, complete] = await readRaw(buffer, raw, delim, nchars, exact)
    } catch (err) {
      if (!isFsError(err) || (err as { code?: string }).code !== 'EBADF') throw err
      // stdin is closed or write-only (`read x <&-`, `read x 0<&1`).
      return readRefusal('bash: read: read error: 0: Bad file descriptor\n')
    }
  }
  if (!raw) line = unescapeRead(line)
  const ifs = visibleEnv(session).IFS ?? ' \t\n'
  if (arrayName !== null) {
    const parts = exact !== null ? (line !== '' ? [line] : []) : splitReadLine(line, ifs, 0)
    if (view.isReadonly(arrayName)) return readonlyRefusal('read', arrayName)
    try {
      await view.set(arrayName, [...parts])
    } catch (err) {
      if (err instanceof PolicyDenied) return refusal('read', err)
      throw err
    }
    const code = complete ? 0 : 1
    return [
      null,
      new IOResult({ exitCode: code }),
      new ExecutionNode({ command: 'read', exitCode: code }),
    ]
  }
  const parts = exact !== null ? [line] : splitReadLine(line, ifs, variables.length)
  for (let i = 0; i < variables.length; i++) {
    const name = variables[i]
    if (name === undefined) continue
    const refused = await readStore(session, view, name, parts[i] ?? '')
    if (refused !== null) return refused
  }
  const code = complete ? 0 : 1
  return [
    null,
    new IOResult({ exitCode: code }),
    new ExecutionNode({ command: 'read', exitCode: code }),
  ]
}

/**
 * Store one `read` target, scalar or `name[sub]` element.
 *
 * bash accepts a subscripted target (`read "m[k]"`), which is an
 * element write, not a variable literally named `m[k]`; the readonly
 * guard resolves the base name first, since that is what `readonly`
 * records. Returns the refusal result, or null when the write landed.
 */
async function readStore(
  session: Session,
  view: SessionView,
  varName: string,
  value: string,
): Promise<Result | null> {
  const match = TARGET_RE.exec(varName)
  const base = match?.[1] ?? varName
  const subscript = match?.[2] ?? null
  if (view.isReadonly(base)) return readonlyRefusal('read', base)
  if (subscript === null) {
    try {
      await view.set(varName, value)
    } catch (err) {
      if (err instanceof PolicyDenied) return refusal('read', err)
      if (err instanceof ArithError) return arithRefusal('read', err)
      throw err
    }
    return null
  }
  let status: 'ok' | 'denied' | 'readonly' | 'subscript'
  try {
    status = await assignElement(session, view, base, subscript, value)
  } catch (err) {
    if (err instanceof PolicyDenied) return refusal('read', err)
    if (err instanceof ArithError) return arithRefusal('read', err)
    throw err
  }
  if (status === 'readonly') return readonlyRefusal('read', base)
  if (status === 'denied') {
    const err = new TextEncoder().encode(`bash: ${base}: permission denied\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'read', exitCode: 1, stderr: err }),
    ]
  }
  if (status !== 'ok') {
    const err = new TextEncoder().encode(`bash: read: ${varName}: bad array subscript\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'read', exitCode: 1, stderr: err }),
    ]
  }
  return null
}

/** The `read` arm. */
export async function readBuiltin(call: BuiltinCall): Promise<Result> {
  return handleRead(
    [...call.argv.args],
    call.session,
    call.stdin,
    sessionView(call.session, call.registry.policies),
  )
}
