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
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { asyncChain } from '../../../io/stream.ts'
import { IOResult } from '../../../io/types.ts'
import type { ByteSource } from '../../../io/types.ts'
import type { CallStack } from '../../../shell/call_stack.ts'
import { SET_FLAG_TO_OPTION } from '../../../shell/types.ts'
import type { Namespace } from '../../mount/namespace/namespace.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import { ReturnSignal } from '../command.ts'
import type { Result } from './scope.ts'

export function handleExport(assignments: string[], session: Session): Result {
  for (const assign of assignments) {
    const eq = assign.indexOf('=')
    if (eq >= 0) {
      const key = assign.slice(0, eq)
      if (session.readonlyVars.has(key)) {
        const err = new TextEncoder().encode(`bash: ${key}: readonly variable\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: err }),
          new ExecutionNode({ command: 'export', exitCode: 1, stderr: err }),
        ]
      }
      session.env[key] = assign.slice(eq + 1)
    } else if (!(assign in session.env)) {
      session.env[assign] = ''
    }
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'export', exitCode: 0 })]
}

export function handleReadonly(assignments: string[], session: Session): Result {
  for (const assign of assignments) {
    const eq = assign.indexOf('=')
    if (eq >= 0) {
      const key = assign.slice(0, eq)
      if (session.readonlyVars.has(key)) {
        const err = new TextEncoder().encode(`bash: ${key}: readonly variable\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: err }),
          new ExecutionNode({ command: 'readonly', exitCode: 1, stderr: err }),
        ]
      }
      session.env[key] = assign.slice(eq + 1)
      session.readonlyVars.add(key)
    } else {
      session.readonlyVars.add(assign)
    }
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'readonly', exitCode: 0 })]
}

export function handleUnset(names: string[], session: Session): Result {
  for (const name of names) {
    if (session.readonlyVars.has(name)) {
      const err = new TextEncoder().encode(
        `bash: unset: ${name}: cannot unset: readonly variable\n`,
      )
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: 'unset', exitCode: 1, stderr: err }),
      ]
    }
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete session.env[name]
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'unset', exitCode: 0 })]
}

export function handlePrintenv(name: string | null, session: Session): Result {
  if (name !== null) {
    const val = session.env[name]
    if (val === undefined) {
      return [
        null,
        new IOResult({ exitCode: 1 }),
        new ExecutionNode({ command: 'printenv', exitCode: 1 }),
      ]
    }
    const out = new TextEncoder().encode(`${val}\n`)
    return [out, new IOResult(), new ExecutionNode({ command: 'printenv', exitCode: 0 })]
  }
  const lines = Object.entries(session.env).map(([k, v]) => `${k}=${v}`)
  lines.sort()
  const out = new TextEncoder().encode(`${lines.join('\n')}\n`)
  return [out, new IOResult(), new ExecutionNode({ command: 'printenv', exitCode: 0 })]
}

export function handleWhoami(namespace: Namespace): Result {
  // GNU whoami reports the effective user and never consults $USER; the
  // workspace user (launch agentId, shared via the namespace store) is
  // the effective identity here.
  const out = new TextEncoder().encode(`${namespace.user}\n`)
  return [out, new IOResult(), new ExecutionNode({ command: 'whoami', exitCode: 0 })]
}

export function handleLocal(assignments: string[], session: Session): Result {
  const locals = session.localVars
  for (const assign of assignments) {
    const eq = assign.indexOf('=')
    if (eq >= 0) {
      const key = assign.slice(0, eq)
      if (locals !== null && !locals.has(key)) {
        locals.set(key, key in session.env ? (session.env[key] ?? null) : null)
      }
      session.env[key] = assign.slice(eq + 1)
    } else {
      if (locals !== null && !locals.has(assign)) {
        locals.set(assign, assign in session.env ? (session.env[assign] ?? null) : null)
      }
      if (!(assign in session.env)) session.env[assign] = ''
    }
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'local', exitCode: 0 })]
}

function isShiftCount(word: string): boolean {
  const body = word.startsWith('-') || word.startsWith('+') ? word.slice(1) : word
  return /^\d+$/.test(body)
}

/** Shift positional parameters, with bash's argument checks. */
export function handleShift(
  args: readonly string[],
  callStack: CallStack | null,
  session: Session | null = null,
): Result {
  if (args.length > 1) {
    const err = new TextEncoder().encode('shift: too many arguments\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'shift', exitCode: 1 }),
    ]
  }
  const first = args[0]
  if (first !== undefined && !isShiftCount(first)) {
    const err = new TextEncoder().encode(`shift: ${first}: numeric argument required\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'shift', exitCode: 1 }),
    ]
  }
  const n = first !== undefined ? Number(first) : 1
  let shifted = false
  if (callStack !== null && callStack.getAllPositional().length > 0) {
    callStack.shift(n)
    shifted = true
  }
  if (!shifted && session !== null) {
    session.positionalArgs = session.positionalArgs.slice(n)
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'shift', exitCode: 0 })]
}

export function handleSet(
  args: string[],
  session: Session,
  _callStack: CallStack | null = null,
): Result {
  if (args.length === 0) {
    const lines = Object.entries(session.env).map(([k, v]) => `${k}=${v}`)
    lines.sort()
    const out = new TextEncoder().encode(`${lines.join('\n')}\n`)
    return [out, new IOResult(), new ExecutionNode({ command: 'set', exitCode: 0 })]
  }
  let i = 0
  while (i < args.length) {
    const tok = args[i] ?? ''
    if (tok === '--') {
      session.positionalArgs = args.slice(i + 1)
      return [null, new IOResult(), new ExecutionNode({ command: 'set', exitCode: 0 })]
    }
    if (tok === '-o' || tok === '+o') {
      if (i + 1 < args.length) {
        const optName = args[i + 1] ?? ''
        session.shellOptions[optName] = tok === '-o'
        i += 2
        continue
      }
      i += 1
      continue
    }
    if ((tok.startsWith('-') || tok.startsWith('+')) && tok.length > 1) {
      const enable = tok.startsWith('-')
      for (const ch of tok.slice(1)) {
        const opt = SET_FLAG_TO_OPTION[ch]
        if (opt !== undefined) session.shellOptions[opt] = enable
      }
      i += 1
      continue
    }
    session.positionalArgs = args.slice(i)
    break
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'set', exitCode: 0 })]
}

export function handleTrap(_session: Session): Result {
  return [null, new IOResult(), new ExecutionNode({ command: 'trap', exitCode: 0 })]
}

/** Return from a function, with bash's argument check. */
export function handleReturn(args: readonly string[]): Result {
  const first = args[0]
  if (first !== undefined && !isShiftCount(first)) {
    // bash prints the error and the function returns 2.
    throw new ReturnSignal(
      2,
      new TextEncoder().encode(`return: ${first}: numeric argument required\n`),
    )
  }
  throw new ReturnSignal(first !== undefined ? Number(first) : 0)
}

/**
 * Read one line into variables, with bash's option handling.
 *
 * Only -r is accepted (our read is already raw, so it is consumed with
 * no effect); anything else errors like bash instead of being treated
 * as a variable name.
 */
export async function handleRead(
  args: string[],
  session: Session,
  stdin: ByteSource | null,
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
  const variables = parse.operands.length > 0 ? parse.operands : ['REPLY']
  if (session.stdinBuffer === null && stdin !== null) {
    if (stdin instanceof Uint8Array) {
      session.stdinBuffer = new AsyncLineIterator(asyncChain(stdin))
    } else {
      session.stdinBuffer = new AsyncLineIterator(stdin)
    }
  }
  let lineBytes: Uint8Array | null = null
  if (session.stdinBuffer !== null) {
    lineBytes = await session.stdinBuffer.readline()
  }
  if (lineBytes === null) {
    for (const v of variables) {
      session.env[v] = ''
    }
    return [
      null,
      new IOResult({ exitCode: 1 }),
      new ExecutionNode({ command: 'read', exitCode: 1 }),
    ]
  }
  const decodedLine = new TextDecoder().decode(lineBytes)
  let lineEnd = decodedLine.length
  while (lineEnd > 0 && decodedLine.charCodeAt(lineEnd - 1) === 10) lineEnd--
  const line = decodedLine.slice(0, lineEnd)
  const ifs = session.env.IFS ?? ' \t\n'
  let parts: string[]
  if (ifs === ' \t\n') {
    if (variables.length === 0) {
      parts = []
    } else if (variables.length === 1) {
      parts = [line]
    } else {
      const split = line.split(/\s+/).filter((p) => p !== '')
      const head = split.slice(0, variables.length - 1)
      const tail = split.slice(variables.length - 1).join(' ')
      parts = tail !== '' ? [...head, tail] : head
    }
  } else if (ifs === '') {
    parts = [line]
  } else {
    const nSplits = Math.max(0, variables.length - 1)
    const chars = new Set(ifs.split(''))
    const out: string[] = []
    let cur = ''
    for (const ch of line) {
      if (chars.has(ch) && out.length < nSplits) {
        out.push(cur)
        cur = ''
        continue
      }
      cur += ch
    }
    out.push(cur)
    parts = out
  }
  for (let i = 0; i < variables.length; i++) {
    const name = variables[i]
    if (name === undefined) continue
    session.env[name] = parts[i] ?? ''
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'read', exitCode: 0 })]
}

/**
 * `source FILE` / `. FILE` — read a script file and execute it.
 * Mirrors Python's `mirage.workspace.executor.builtins.handle_source`.
 */
