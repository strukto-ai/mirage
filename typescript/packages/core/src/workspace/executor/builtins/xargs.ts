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

import { SHELL_SPECS, parseShellOptions } from '../../../commands/spec/shell.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import type { ByteSource } from '../../../io/types.ts'
import { asyncChain } from '../../../io/stream.ts'
import { shellJoin } from '../../../shell/join.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import type { Result, ExecuteStringFn } from './scope.ts'

const UNSUPPORTED = ['I', 'P']

function usageError(message: string): Result {
  const stderr = new TextEncoder().encode(`xargs: ${message}\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr }),
    new ExecutionNode({ command: 'xargs', exitCode: 1 }),
  ]
}

function splitItems(data: Uint8Array, flags: Record<string, string | boolean>): string[] {
  if (flags['0'] === true) {
    return new TextDecoder()
      .decode(data)
      .split('\0')
      .filter((s) => s !== '')
  }
  const rawDelim = flags.d
  if (typeof rawDelim === 'string') {
    const delim = rawDelim.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
    let text = new TextDecoder().decode(data)
    if (text.endsWith(delim)) text = text.slice(0, -delim.length)
    return text === '' ? [] : text.split(delim)
  }
  return new TextDecoder()
    .decode(data)
    .split(/\s+/)
    .filter((s) => s !== '')
}

/**
 * Run a command with words read from stdin appended (GNU xargs).
 *
 * GNU xargs execs the command directly, so every input word must reach
 * it as exactly one argv token. The inner line is built with shellJoin:
 * a plain join would be re-parsed by the shell, splitting words with
 * whitespace and executing $(...) found in input.
 */
export async function handleXargs(
  executeFn: ExecuteStringFn,
  args: readonly string[],
  session: Session,
  stdin: ByteSource | null,
): Promise<Result> {
  const parse = parseShellOptions(SHELL_SPECS.xargs, args)
  if (parse.invalid !== null) {
    if (parse.invalid.startsWith('--')) return usageError(`unrecognized option '${parse.invalid}'`)
    return usageError(`invalid option -- '${parse.invalid}'`)
  }
  if (parse.needsValue !== null) {
    return usageError(`option requires an argument -- '${parse.needsValue}'`)
  }
  for (const name of UNSUPPORTED) {
    if (name in parse.flags) return usageError(`unsupported option -- '${name}'`)
  }
  let maxArgs: number | null = null
  const rawN = parse.flags.n
  if (typeof rawN === 'string') {
    if (!/^\d+$/.test(rawN)) return usageError(`invalid number "${rawN}" for -n option`)
    maxArgs = Number(rawN)
    if (maxArgs < 1) return usageError(`value ${rawN} for -n option should be >= 1`)
  }

  const data = await materialize(stdin)
  const items = splitItems(data, parse.flags)
  if (items.length === 0 && parse.flags.r === true) {
    return [null, new IOResult(), new ExecutionNode({ command: 'xargs', exitCode: 0 })]
  }

  const command = parse.operands.length > 0 ? parse.operands : ['echo']
  const batches: string[][] = []
  if (maxArgs === null) {
    batches.push(items)
  } else {
    for (let i = 0; i < items.length; i += maxArgs) batches.push(items.slice(i, i + maxArgs))
    if (batches.length === 0) batches.push([])
  }

  const stdouts: ByteSource[] = []
  let merged = new IOResult()
  let exitCode = 0
  for (const batch of batches) {
    const inner = shellJoin([...command, ...batch])
    const io = await executeFn(inner, { sessionId: session.sessionId })
    if (io.stdout !== null) stdouts.push(io.stdout)
    merged = await merged.merge(io)
    if (io.exitCode === 126 || io.exitCode === 127) {
      // GNU xargs stops when the command cannot run or is missing.
      exitCode = io.exitCode
      break
    }
    if (io.exitCode !== 0) {
      // GNU exits 123 when any invocation fails, but keeps going.
      exitCode = 123
    }
  }
  merged.exitCode = exitCode
  const out = stdouts.length > 0 ? asyncChain(...stdouts) : null
  return [out, merged, new ExecutionNode({ command: 'xargs', exitCode })]
}
