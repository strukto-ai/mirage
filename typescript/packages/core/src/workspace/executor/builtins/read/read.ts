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

import { shellVoice } from '../../../../shell/voice.ts'
import { parseShellOptions, SHELL_SPECS } from '../../../../commands/spec/shell.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import { isFsError } from '../../../../errors/fs.ts'
import { type AsyncLineIterator, lineBuffer } from '../../../../io/async_line_iterator.ts'
import { checkMemory } from '../../../../io/memory.ts'
import type { ByteSource } from '../../../../io/types.ts'
import { IOResult } from '../../../../io/types.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import { makeArray } from '../../../../shell/array.ts'
import { readCounted as counted, readFields, readText } from '../../../../rs/shell.ts'
import { decodeText, encodeText } from '../../../../shell/bytes.ts'
import { endsEscaped } from '../../../../shell/escapes.ts'
import type { SessionView } from '../../../../view/types.ts'
import type { SubscriptFn } from '../../../expand/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { assignElement, sessionView, visibleEnv } from '../../../session/state.ts'
import { ExecutionNode } from '../../../types.ts'
import { TARGET_RE } from '../constants.ts'
import {
  builtinUsage,
  countOperand,
  deniedLine,
  identifierLine,
  isValidName,
  readonlyRefusal,
  recordDelimiter,
  refusal,
  requireView,
  subscriptExpansion,
} from '../shared.ts'
import type { BuiltinCall } from '../types.ts'
import { READ_VALUE_LETTERS } from './constants.ts'

/** bash's refusal of a name `read` cannot assign. */
function invalidName(name: string): RedirectResult {
  return readRefusal(`${identifierLine('read', name)}\n`)
}

function readRefusal(msg: string): RedirectResult {
  const err = encodeText(msg)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: err }),
    new ExecutionNode({ command: 'read', exitCode: 1, stderr: err }),
  ]
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

async function readRaw(
  buffer: AsyncLineIterator,
  raw: boolean,
  delim: number,
  nchars: number | null,
  exact: number | null,
  signal?: AbortSignal,
): Promise<[string, boolean]> {
  const count = exact ?? nchars
  const stop = exact !== null ? null : delim
  if (count !== null && raw) {
    const [data, complete] = await buffer.readChars(count, stop, signal)
    return [decodeText(data), complete]
  }
  if (count !== null) return readCounted(buffer, count, stop, signal)
  let [data, complete] = await buffer.readUntil(delim, signal)
  let held = data.byteLength
  let text = decodeText(data)
  while (!raw && complete && endsEscaped(text)) {
    ;[data, complete] = await buffer.readUntil(delim, signal)
    held += data.byteLength + 1
    checkMemory(held)
    text += decodeText(new Uint8Array([delim])) + decodeText(data)
  }
  return [text, complete]
}

/**
 * Read `count` characters as `-n` and `-N` count them without `-r`: once
 * backslashes are processed, so `\x` is one and a backslash-newline none.
 * The character after a backslash is always read, and a quoted delimiter
 * kept. Mirrors Python's _read_counted.
 */
async function readCounted(
  buffer: AsyncLineIterator,
  count: number,
  delim: number | null,
  signal?: AbortSignal,
): Promise<[string, boolean]> {
  let text = ''
  let got = 0
  let held = 0
  let escaped = false
  while (got < count) {
    const want = escaped ? 1 : count - got
    const [data, complete] = await buffer.readChars(want, delim, signal)
    held += data.byteLength
    checkMemory(held)
    const piece = decodeText(data)
    const [n, after] = counted(piece, escaped)
    escaped = after
    text += piece
    got += n
    if (!complete) return [text, false]
    if (Array.from(piece).length < want) {
      if (!escaped || delim === null) return [text, true]
      text += decodeText(new Uint8Array([delim]))
      if (delim !== 10) got++
      escaped = false
    }
  }
  return [text, true]
}

/**
 * One line as a bare `read` stores it in REPLY: backslashes processed, a
 * continuation joined, nothing split off; null at end of input. `select`
 * takes its choice this way (bash calls this builtin).
 */
export async function readReply(
  buffer: AsyncLineIterator,
  signal?: AbortSignal,
): Promise<string | null> {
  const [line, complete] = await readRaw(buffer, false, 10, null, null, signal)
  return complete ? readText(line, false) : null
}

/**
 * Read one line (or delimited record, or character count) into
 * variables, with bash's option surface. `-r` turns off backslash
 * processing; `-d C` reads to `C`; `-n N`/`-N N` bound the read; `-a
 * NAME` stores fields in an array; `-t` accepts a timeout (0 answers
 * whether a source is present); `-p -s -e -i` are non-tty no-ops; `-u FD`
 * reads an open descriptor, sharing its cursor with aliases. The
 * status is 1 when end of input ended the read.
 */
export async function handleRead(
  args: string[],
  session: SessionState,
  stdin: ByteSource | null,
  state: SessionView | null = null,
  signal?: AbortSignal,
  subscripts: SubscriptFn | null = null,
): Promise<RedirectResult> {
  const parse = parseShellOptions(SHELL_SPECS.read, args)
  if (parse.invalid !== null) {
    const token = parse.invalid.startsWith('--') ? parse.invalid : `-${parse.invalid}`
    const err = encodeText(`${shellVoice()}read: ${token}: invalid option\n${builtinUsage('read')}`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'read', exitCode: 2 }),
    ]
  }
  if (parse.needsValue !== null) {
    const err = encodeText(
      `${shellVoice()}read: -${parse.needsValue}: option requires an argument\n${builtinUsage('read')}`,
    )
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'read', exitCode: 2 }),
    ]
  }
  const flags = parse.flags
  const raw = flags.r === true
  const delim = recordDelimiter(typeof flags.d === 'string' ? flags.d : null)
  for (const key of ['n', 'N'] as const) {
    if (typeof flags[key] === 'string' && countOperand(flags[key]) === null) {
      return readRefusal(`${shellVoice()}read: ${flags[key]}: invalid number\n`)
    }
  }
  let nchars: number | null = null
  let exact: number | null = null
  const which = lastCountFlag(args)
  if (which === 'N') exact = countOperand(String(flags.N))
  else if (which === 'n') nchars = countOperand(String(flags.n))
  let timeout: number | null = null
  if (typeof flags.t === 'string') {
    timeout = readTimeout(flags.t)
    if (timeout === null) {
      return readRefusal(`${shellVoice()}read: ${flags.t}: invalid timeout specification\n`)
    }
  }
  if (typeof flags.u === 'string' && flags.u !== '0') {
    const descriptor = /^\d+$/.test(flags.u) ? session.descriptors.get(Number(flags.u)) : undefined
    if (descriptor?.source == null)
      return readRefusal(
        `${shellVoice()}read: ${flags.u}: invalid file descriptor: Bad file descriptor\n`,
      )
    stdin = descriptor.source
  }
  const arrayName = typeof flags.a === 'string' ? flags.a : null
  if (arrayName !== null && !isValidName(arrayName)) {
    return invalidName(arrayName)
  }
  const variables = parse.operands.length > 0 ? parse.operands : ['REPLY']
  // A first name it cannot assign refuses before anything is read.
  if (!TARGET_RE.test(variables[0] ?? '')) return invalidName(variables[0] ?? '')
  const view = requireView(state)
  const buffer = stdin !== null ? lineBuffer(stdin) : null
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
      ;[line, complete] = await readRaw(buffer, raw, delim, nchars, exact, signal)
    } catch (err) {
      if (!isFsError(err) || (err as { code?: string }).code !== 'EBADF') throw err
      // stdin is closed or write-only (`read x <&-`, `read x 0<&1`).
      return readRefusal(`${shellVoice()}read: read error: 0: Bad file descriptor\n`)
    }
  }
  const ifs = visibleEnv(session).IFS ?? ' \t\n'
  const whole = readText(line, raw)
  if (arrayName !== null) {
    const parts = exact !== null ? (whole !== '' ? [whole] : []) : readFields(line, ifs, 0, raw)
    if (view.isReadonly(arrayName)) return readonlyRefusal('read', arrayName)
    try {
      await view.set(arrayName, makeArray(parts))
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
  // With no name the line goes to REPLY whole, its blanks kept.
  const parts =
    exact !== null || parse.operands.length === 0
      ? [whole]
      : readFields(line, ifs, variables.length, raw)
  for (let i = 0; i < variables.length; i++) {
    const name = variables[i]
    if (name === undefined) continue
    // bash stops at the first name it cannot assign, the ones before it
    // assigned.
    if (!TARGET_RE.test(name)) return invalidName(name)
    const refused = await readStore(session, view, name, parts[i] ?? '', subscripts)
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
 * element write, not a variable literally named `m[k]`, its subscript read
 * before a readonly base refuses (`read 'a[x=3]'` leaves x at 3).
 * `policies` are what a subscript's assignments clear. Returns the
 * refusal result, or null when the write landed.
 */
async function readStore(
  session: SessionState,
  view: SessionView,
  varName: string,
  value: string,
  subscripts: SubscriptFn | null = null,
): Promise<RedirectResult | null> {
  const match = TARGET_RE.exec(varName)
  const base = match?.[1] ?? varName
  let subscript = match?.[2] ?? null
  if (subscript === null) {
    if (view.isReadonly(base)) return readonlyRefusal('read', base)
    try {
      await view.set(varName, value)
    } catch (err) {
      if (err instanceof PolicyDenied) return refusal('read', err)
      throw err
    }
    return null
  }
  if (subscripts !== null) subscript = await subscripts(subscript)
  let status: string
  try {
    status = await assignElement(session, base, subscript, value)
  } catch (err) {
    if (err instanceof PolicyDenied) return refusal('read', err)
    throw err
  }
  if (status === 'readonly') return readonlyRefusal('read', base)
  if (status === 'denied') {
    const err = encodeText(`${deniedLine(base)}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'read', exitCode: 1, stderr: err }),
    ]
  }
  if (status !== 'ok') {
    const err = encodeText(`${shellVoice()}read: ${varName}: bad array subscript\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'read', exitCode: 1, stderr: err }),
    ]
  }
  return null
}

/** The `read` arm. */
export async function readBuiltin(call: BuiltinCall): Promise<RedirectResult> {
  return handleRead(
    [...call.argv.args],
    call.context.session,
    call.stdin,
    sessionView(call.context.session, call.context.frame.diagnostics),
    call.signal,
    subscriptExpansion(call),
  )
}
