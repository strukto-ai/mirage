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
import { IOResult, materialize } from '../../../../io/types.ts'
import type { ByteSource } from '../../../../io/types.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import { arraySet, type ShellArray } from '../../../../shell/array.ts'
import { singleQuote } from '../../../../utils/quote.ts'
import type { SessionView } from '../../../../ops/types.ts'
import type { Session } from '../../../session/session.ts'
import { sessionView, visibleArrays, visibleAssocs } from '../../../session/state.ts'
import { ExecutionNode } from '../../../types.ts'
import { fail, requireView } from '../shared.ts'
import type { BuiltinCall, ExecuteStringFn, Result } from '../types.ts'

const USAGE =
  'mapfile: usage: mapfile [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]'
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const DEFAULT_QUANTUM = 5000

function count(text: string): number | null {
  return /^[0-9]+$/.test(text) ? parseInt(text, 10) : null
}

/**
 * Read input into an indexed array, one element per line. `-d C` splits
 * on `C`; `-t` strips the delimiter; `-n N` bounds, `-s N` skips, `-O I`
 * places (and keeps the array's other elements); `-C CB`/`-c Q` calls
 * back. The array is `MAPFILE` by default; a scalar becomes an array, an
 * associative one is refused.
 */
export async function handleMapfile(
  args: string[],
  session: Session,
  stdin: ByteSource | null,
  executeFn: ExecuteStringFn,
  state: SessionView | null = null,
  cmd = 'mapfile',
  signal?: AbortSignal,
): Promise<Result> {
  const parse = parseShellOptions(SHELL_SPECS.mapfile, args)
  if (parse.invalid !== null) {
    const token = parse.invalid.startsWith('--') ? parse.invalid : `-${parse.invalid}`
    return fail(cmd, `bash: ${cmd}: ${token}: invalid option\n${USAGE}\n`, 2)
  }
  if (parse.needsValue !== null) {
    return fail(
      cmd,
      `bash: ${cmd}: -${parse.needsValue}: option requires an argument\n${USAGE}\n`,
      2,
    )
  }
  const flags = parse.flags
  let delim = 10
  if (typeof flags.d === 'string') delim = flags.d.length > 0 ? flags.d.charCodeAt(0) : 0
  let limit = 0
  let origin = 0
  let skip = 0
  let quantum = DEFAULT_QUANTUM
  const numeric: [string, string, (v: number) => void][] = [
    ['n', 'line count', (v) => (limit = v)],
    ['O', 'array origin', (v) => (origin = v)],
    ['s', 'line count', (v) => (skip = v)],
    ['c', 'callback quantum', (v) => (quantum = v)],
  ]
  for (const [key, label, apply] of numeric) {
    const raw = flags[key]
    if (typeof raw !== 'string') continue
    const value = count(raw)
    if (value === null || (key === 'c' && value === 0)) {
      return fail(cmd, `bash: ${cmd}: ${raw}: invalid ${label}\n`, 1)
    }
    apply(value)
  }
  if (typeof flags.u === 'string' && flags.u !== '0') {
    return fail(cmd, `bash: ${cmd}: ${flags.u}: invalid file descriptor: Bad file descriptor\n`, 1)
  }
  const strip = flags.t === true
  const callback = typeof flags.C === 'string' ? flags.C : null
  const name = parse.operands.length > 0 ? (parse.operands[0] ?? '') : 'MAPFILE'
  if (!IDENTIFIER.test(name))
    return fail(cmd, `bash: ${cmd}: \`${name}': not a valid identifier\n`, 1)
  const view = requireView(state)
  if (view.isReadonly(name)) return fail(cmd, `bash: ${name}: readonly variable\n`, 1)
  if (name in visibleAssocs(session))
    return fail(cmd, `bash: ${cmd}: ${name}: not an indexed array\n`, 1)

  if (stdin !== null && (session.stdinBuffer === null || session.stdinSource !== stdin)) {
    if (stdin instanceof Uint8Array) session.stdinBuffer = new AsyncLineIterator(asyncChain(stdin))
    else session.stdinBuffer = new AsyncLineIterator(stdin)
    session.stdinSource = stdin
  }
  const buffer = session.stdinBuffer
  const existing = visibleArrays(session)[name]
  const arr: ShellArray = existing !== undefined && 'O' in flags ? [...existing] : []
  const dec = new TextDecoder()
  let index = origin
  let stored = 0
  let seen = 0
  const outputs: Uint8Array[] = []
  const errs: Uint8Array[] = []
  while (buffer !== null && (limit === 0 || stored < limit)) {
    const [data, found] = await buffer.readUntil(delim, signal)
    if (!found && data.byteLength === 0) break
    seen++
    if (seen <= skip) continue
    let text = dec.decode(data)
    if (found && !strip) text += String.fromCharCode(delim)
    arraySet(arr, index, text)
    stored++
    if (callback !== null && stored % quantum === 0) {
      // The record is data, not source: bash builds the callback line
      // with `sh_single_quote`, so a record reading `x; rm f` arrives as
      // one argument rather than running a second command.
      const io = await executeFn(`${callback} ${String(index)} ${singleQuote(text)}`, {
        sessionId: session.sessionId,
      })
      const out = await materialize(io.stdout)
      if (out.byteLength > 0) outputs.push(out)
      const errOut = await materialize(io.stderr)
      if (errOut.byteLength > 0) errs.push(errOut)
    }
    index++
    if (!found) break
  }
  try {
    await view.set(name, arr)
  } catch (err) {
    if (err instanceof PolicyDenied) return fail(cmd, `${err.message}\n`, 1)
    throw err
  }
  const stdout = outputs.length > 0 ? concatBytes(outputs) : null
  const stderr = errs.length > 0 ? concatBytes(errs) : null
  return [stdout, new IOResult({ stderr }), new ExecutionNode({ command: cmd, exitCode: 0 })]
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

/** The `mapfile` / `readarray` arm; the head word is what diagnostics name. */
export async function mapfileBuiltin(call: BuiltinCall): Promise<Result> {
  return handleMapfile(
    [...call.argv.args],
    call.session,
    call.stdin,
    call.executeFn,
    sessionView(call.session, call.registry.policies),
    call.argv.name,
    call.signal,
  )
}
