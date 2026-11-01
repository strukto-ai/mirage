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

import { parseShellOptions, SHELL_SPECS } from '../../../../commands/spec/shell.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import { lineBuffer } from '../../../../io/async_line_iterator.ts'
import { checkMemory } from '../../../../io/memory.ts'
import type { ByteSource } from '../../../../io/types.ts'
import { IOResult, materialize } from '../../../../io/types.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import { arraySet, type ShellArray } from '../../../../shell/array.ts'
import { decodeText, encodeText } from '../../../../shell/bytes.ts'
import { concat } from '../../../../utils/bytes.ts'
import { singleQuote } from '../../../../utils/quote.ts'
import type { SessionView } from '../../../../view/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { sessionView, visibleArrays, visibleAssocs } from '../../../session/state.ts'
import { ExecutionNode } from '../../../types.ts'
import { builtinUsage, countOperand, fail, recordDelimiter, requireView } from '../shared.ts'
import type { BuiltinCall, ExecuteStringFn } from '../types.ts'

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const DEFAULT_QUANTUM = 5000
// The bytes one array slot costs, a hole the array pads with included.
const SLOT = 8

/**
 * Read input into an indexed array, one element per line. `-d C` splits
 * on `C`; `-t` strips the delimiter; `-n N` bounds, `-s N` skips, `-O I`
 * places (and keeps the array's other elements); `-C CB`/`-c Q` calls
 * back. The array is `MAPFILE` by default; a scalar becomes an array, an
 * associative one is refused.
 */
export async function handleMapfile(
  args: string[],
  session: SessionState,
  stdin: ByteSource | null,
  executeFn: ExecuteStringFn,
  state: SessionView | null = null,
  cmd = 'mapfile',
  signal?: AbortSignal,
): Promise<RedirectResult> {
  const parse = parseShellOptions(SHELL_SPECS.mapfile, args)
  if (parse.invalid !== null) {
    const token = parse.invalid.startsWith('--') ? parse.invalid : `-${parse.invalid}`
    return fail(cmd, `bash: ${cmd}: ${token}: invalid option\n${builtinUsage(cmd)}`, 2)
  }
  if (parse.needsValue !== null) {
    return fail(
      cmd,
      `bash: ${cmd}: -${parse.needsValue}: option requires an argument\n${builtinUsage(cmd)}`,
      2,
    )
  }
  const flags = parse.flags
  const delim = recordDelimiter(typeof flags.d === 'string' ? flags.d : null)
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
    const value = countOperand(raw)
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

  const buffer = stdin !== null ? lineBuffer(stdin) : null
  const existing = visibleArrays(session)[name]
  const arr: ShellArray = existing !== undefined && 'O' in flags ? [...existing] : []
  let index = origin
  let stored = 0
  let seen = 0
  // The array's bytes, its slots and what it keeps in them, so neither -O
  // appends nor empty records grow it past the workspace's max_memory a few
  // lines at a time.
  let held = arr.reduce(
    (sum, v) => sum + (v === null ? 0 : encodeText(v).byteLength),
    SLOT * arr.length,
  )
  const outputs: Uint8Array[] = []
  const errs: Uint8Array[] = []
  while (buffer !== null && (limit === 0 || stored < limit)) {
    const [data, found] = await buffer.readUntil(delim, signal)
    if (!found && data.byteLength === 0) break
    seen++
    if (seen <= skip) continue
    const record = found && !strip ? concat([data, Uint8Array.of(delim)]) : data
    const replaced = arr[index] ?? null
    held +=
      SLOT * Math.max(index + 1 - arr.length, 0) +
      record.byteLength -
      (replaced === null ? 0 : encodeText(replaced).byteLength)
    checkMemory(held)
    const text = decodeText(record)
    arraySet(arr, index, text)
    stored++
    if (callback !== null && stored % quantum === 0) {
      // The record is data, not source: bash single-quotes it in the
      // callback line, so a record reading `x; rm f` arrives as
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
  const stdout = outputs.length > 0 ? concat(outputs) : null
  const stderr = errs.length > 0 ? concat(errs) : null
  return [stdout, new IOResult({ stderr }), new ExecutionNode({ command: cmd, exitCode: 0 })]
}

/** The `mapfile` / `readarray` arm; the head word is what diagnostics name. */
export async function mapfileBuiltin(call: BuiltinCall): Promise<RedirectResult> {
  return handleMapfile(
    [...call.argv.args],
    call.context.session,
    call.stdin,
    call.executeFn,
    sessionView(call.context.session, call.registry.policies, call.context.frame.diagnostics),
    call.argv.name,
    call.signal,
  )
}
