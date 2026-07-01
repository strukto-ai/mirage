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

import { resolvePath } from '../../../commands/spec/parser.ts'
import { IOResult } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { Namespace } from '../../mount/namespace.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import type { Result } from './scope.ts'

function typed(arg: string | PathSpec): string {
  if (arg instanceof PathSpec) return arg.asTyped ?? arg.original
  return arg
}

function abs(arg: string | PathSpec, cwd: string): string {
  if (arg instanceof PathSpec) return arg.original
  return resolvePath(cwd, arg)
}

function allKnown(chars: string, known: string): boolean {
  for (const c of chars) if (!known.includes(c)) return false
  return true
}

function splitFlags(
  args: (string | PathSpec)[],
  known: string,
): [Set<string>, (string | PathSpec)[]] {
  const flags = new Set<string>()
  const operands: (string | PathSpec)[] = []
  let parsing = true
  for (const arg of args) {
    const s = arg instanceof PathSpec ? arg.original : arg
    if (parsing && s === '--') {
      parsing = false
      continue
    }
    if (parsing && s !== '-' && s.length >= 2 && s.startsWith('-') && allKnown(s.slice(1), known)) {
      for (const c of s.slice(1)) flags.add(c)
      continue
    }
    parsing = false
    operands.push(arg)
  }
  return [flags, operands]
}

export function linkFlags(args: (string | PathSpec)[], known: string): Set<string> {
  return splitFlags(args, known)[0]
}

function errorResult(command: string, message: string): Result {
  const err = new TextEncoder().encode(message)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: err }),
    new ExecutionNode({ command, exitCode: 1, stderr: err }),
  ]
}

export function handleLn(
  namespace: Namespace,
  session: Session,
  args: (string | PathSpec)[],
): Result {
  const [flags, operands] = splitFlags(args, 'sfnv')
  const targetArg = operands[0]
  const linkArg = operands[1]
  if (targetArg === undefined || linkArg === undefined) {
    return errorResult('ln', 'ln: missing file operand\n')
  }
  const linkAbs = abs(linkArg, session.cwd)
  const targetTyped = typed(targetArg)
  const exists = namespace.isLink(linkAbs) && !flags.has('f')
  if (namespace.isMountRoot(linkAbs) || exists) {
    return errorResult(
      'ln',
      `ln: failed to create symbolic link '${typed(linkArg)}': File exists\n`,
    )
  }
  namespace.symlink(linkAbs, targetTyped, Date.now() / 1000)
  let out: Uint8Array | null = null
  if (flags.has('v')) {
    out = new TextEncoder().encode(`'${typed(linkArg)}' -> '${targetTyped}'\n`)
  }
  return [out, new IOResult(), new ExecutionNode({ command: 'ln', exitCode: 0 })]
}

export function handleReadlink(
  namespace: Namespace,
  session: Session,
  args: (string | PathSpec)[],
): Result {
  const [flags, operands] = splitFlags(args, 'fenm')
  if (operands.length === 0) {
    return errorResult('readlink', 'readlink: missing operand\n')
  }
  const lines: string[] = []
  let exitCode = 0
  for (const op of operands) {
    const target = namespace.readlink(abs(op, session.cwd))
    if (target === null) {
      exitCode = 1
      continue
    }
    lines.push(target)
  }
  if (lines.length === 0) {
    return [null, new IOResult({ exitCode }), new ExecutionNode({ command: 'readlink', exitCode })]
  }
  const text = flags.has('n') ? lines.join('') : lines.map((l) => l + '\n').join('')
  return [
    new TextEncoder().encode(text),
    new IOResult({ exitCode }),
    new ExecutionNode({ command: 'readlink', exitCode }),
  ]
}
