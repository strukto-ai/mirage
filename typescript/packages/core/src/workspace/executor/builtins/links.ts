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
import type { MountRegistry } from '../../mount/registry.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import type { Result } from './scope.ts'

function typed(arg: string | PathSpec): string {
  return arg instanceof PathSpec ? (arg.asTyped ?? arg.original) : arg
}

function splitFlags(
  args: (string | PathSpec)[],
  known: string,
): { flags: Set<string>; operands: (string | PathSpec)[] } {
  const flags = new Set<string>()
  const operands: (string | PathSpec)[] = []
  let parsing = true
  for (const arg of args) {
    const s = arg instanceof PathSpec ? arg.original : arg
    if (parsing && s === '--') {
      parsing = false
      continue
    }
    let isFlagCluster = parsing && s !== '-' && s.length >= 2 && s.startsWith('-')
    if (isFlagCluster) {
      for (const c of s.slice(1)) {
        if (!known.includes(c)) {
          isFlagCluster = false
          break
        }
      }
    }
    if (isFlagCluster) {
      for (const c of s.slice(1)) flags.add(c)
      continue
    }
    parsing = false
    operands.push(arg)
  }
  return { flags, operands }
}

export function linkFlags(args: (string | PathSpec)[], known: string): Set<string> {
  return splitFlags(args, known).flags
}

function abs(arg: string | PathSpec, cwd: string): string {
  return arg instanceof PathSpec ? arg.original : resolvePath(cwd, arg)
}

export function handleLn(
  registry: MountRegistry,
  session: Session,
  args: (string | PathSpec)[],
): Result {
  const { flags, operands } = splitFlags(args, 'sfnv')
  const targetArg = operands[0]
  const linkArg = operands[1]
  if (targetArg === undefined || linkArg === undefined) {
    const err = new TextEncoder().encode('ln: missing file operand\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'ln', exitCode: 1, stderr: err }),
    ]
  }
  const linkAbs = abs(linkArg, session.cwd)
  const targetTyped = typed(targetArg)
  const exists = linkAbs in registry.symlinks && !flags.has('f')
  if (registry.isMountRoot(linkAbs) || exists) {
    const err = new TextEncoder().encode(
      `ln: failed to create symbolic link '${typed(linkArg)}': File exists\n`,
    )
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'ln', exitCode: 1, stderr: err }),
    ]
  }
  registry.symlinks[linkAbs] = targetTyped
  const out = flags.has('v')
    ? new TextEncoder().encode(`'${typed(linkArg)}' -> '${targetTyped}'\n`)
    : null
  return [out, new IOResult(), new ExecutionNode({ command: 'ln', exitCode: 0 })]
}

export function handleReadlink(
  registry: MountRegistry,
  session: Session,
  args: (string | PathSpec)[],
): Result {
  const { flags, operands } = splitFlags(args, 'fenm')
  if (operands.length === 0) {
    const err = new TextEncoder().encode('readlink: missing operand\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'readlink', exitCode: 1, stderr: err }),
    ]
  }
  const lines: string[] = []
  let exitCode = 0
  for (const op of operands) {
    const target = registry.symlinks[abs(op, session.cwd)]
    if (target === undefined) {
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
