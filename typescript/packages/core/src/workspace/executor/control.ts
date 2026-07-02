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

import { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import { asyncChain } from '../../io/stream.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult } from '../../io/types.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ERREXIT_EXEMPT_TYPES } from '../../shell/types.ts'
import { PathSpec } from '../../types.ts'
import type { TSNodeLike } from '../expand/variable.ts'
import type { Session } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import type { ExecuteNodeFn } from './jobs.ts'
import { fnmatch } from '../../utils/fnmatch.ts'

function installStdinBuffer(
  session: Session,
  stdin: ByteSource | null,
): [AsyncLineIterator | null, ByteSource | null] {
  const prev = session.stdinBuffer
  if (stdin !== null) {
    const source = stdin instanceof Uint8Array ? asyncChain(stdin) : stdin
    session.stdinBuffer = new AsyncLineIterator(source)
    return [prev, null]
  }
  return [prev, stdin]
}

type Result = [ByteSource | null, IOResult, ExecutionNode]

const MAX_WHILE = 10_000

export class BreakSignal extends Error {
  readonly stdout: ByteSource | null
  readonly io: IOResult
  constructor(stdout: ByteSource | null = null, io: IOResult = new IOResult()) {
    super('break')
    this.name = 'BreakSignal'
    this.stdout = stdout
    this.io = io
  }
}

export class ContinueSignal extends Error {
  readonly stdout: ByteSource | null
  readonly io: IOResult
  constructor(stdout: ByteSource | null = null, io: IOResult = new IOResult()) {
    super('continue')
    this.name = 'ContinueSignal'
    this.stdout = stdout
    this.io = io
  }
}

async function executeBody(
  executeNode: ExecuteNodeFn,
  body: readonly TSNodeLike[],
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
): Promise<Result> {
  const allStdout: (ByteSource | null)[] = []
  let mergedIo = new IOResult()
  let lastExec = new ExecutionNode({ command: '', exitCode: 0 })
  for (const cmd of body) {
    try {
      const [stdout, io, execNode] = await executeNode(cmd, session, stdin, callStack)
      lastExec = execNode
      allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
      if (
        io.exitCode !== 0 &&
        session.shellOptions.errexit === true &&
        !ERREXIT_EXEMPT_TYPES.has(cmd.type)
      ) {
        mergedIo.exitCode = io.exitCode
        break
      }
    } catch (sig) {
      if (sig instanceof BreakSignal) {
        if (sig.stdout !== null) allStdout.push(sig.stdout)
        mergedIo = await mergedIo.merge(sig.io)
        const combined = chainNonNull(allStdout)
        throw new BreakSignal(combined, mergedIo)
      }
      if (sig instanceof ContinueSignal) {
        if (sig.stdout !== null) allStdout.push(sig.stdout)
        mergedIo = await mergedIo.merge(sig.io)
        const combined = chainNonNull(allStdout)
        throw new ContinueSignal(combined, mergedIo)
      }
      throw sig
    }
  }
  const combined = chainNonNull(allStdout)
  return [combined, mergedIo, lastExec]
}

function chainNonNull(sources: readonly (ByteSource | null)[]): ByteSource | null {
  const nonNull = sources.filter((s): s is ByteSource => s !== null)
  if (nonNull.length === 0) return null
  return asyncChain(...nonNull)
}

function collectLoopResult(
  allStdout: readonly (ByteSource | null)[],
  mergedIo: IOResult,
  label: string,
): Result {
  const execNode = new ExecutionNode({ command: label, exitCode: mergedIo.exitCode })
  const combined = chainNonNull(allStdout)
  return [combined, mergedIo, execNode]
}

export async function handleIf(
  executeNode: ExecuteNodeFn,
  branches: readonly [TSNodeLike, TSNodeLike[]][],
  elseBody: TSNodeLike[] | null,
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  for (const [condition, body] of branches) {
    const [condStdout, condIo] = await executeNode(condition, session, stdin, callStack)
    await applyBarrier(condStdout, condIo, BarrierPolicy.STATUS)
    session.lastExitCode = condIo.exitCode
    if (condIo.exitCode === 0) {
      return executeBody(executeNode, body, session, stdin, callStack)
    }
  }
  if (elseBody !== null) {
    return executeBody(executeNode, elseBody, session, stdin, callStack)
  }
  return [null, new IOResult(), new ExecutionNode({ exitCode: 0 })]
}

export async function handleFor(
  executeNode: ExecuteNodeFn,
  variable: string,
  values: readonly (string | PathSpec)[],
  body: readonly TSNodeLike[],
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  let mergedIo = new IOResult()
  const allStdout: (ByteSource | null)[] = []
  const savedValue = session.env[variable]
  const hadKey = variable in session.env
  const [prevBuffer, bodyStdin] = installStdinBuffer(session, stdin)
  stdin = bodyStdin

  try {
    for (const val of values) {
      session.env[variable] = val instanceof PathSpec ? val.virtual : val
      try {
        const [stdout, io] = await executeBody(executeNode, body, session, stdin, callStack)
        allStdout.push(stdout)
        mergedIo = await mergedIo.merge(io)
      } catch (sig) {
        if (sig instanceof BreakSignal) {
          if (sig.stdout !== null) allStdout.push(sig.stdout)
          mergedIo = await mergedIo.merge(sig.io)
          break
        }
        if (sig instanceof ContinueSignal) {
          if (sig.stdout !== null) allStdout.push(sig.stdout)
          mergedIo = await mergedIo.merge(sig.io)
          continue
        }
        throw sig
      }
    }
  } finally {
    if (hadKey && savedValue !== undefined) {
      session.env[variable] = savedValue
    } else {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete session.env[variable]
    }
    session.stdinBuffer = prevBuffer
  }
  return collectLoopResult(allStdout, mergedIo, 'for')
}

async function conditionLoop(
  executeNode: ExecuteNodeFn,
  condition: TSNodeLike,
  body: readonly TSNodeLike[],
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  label: string,
  breakOnZero: boolean,
): Promise<Result> {
  let mergedIo = new IOResult()
  const allStdout: (ByteSource | null)[] = []
  let hitLimit = true
  const [prevBuffer, bodyStdin] = installStdinBuffer(session, stdin)
  stdin = bodyStdin

  try {
    for (let i = 0; i < MAX_WHILE; i++) {
      const [condStdout, condIo] = await executeNode(condition, session, stdin, callStack)
      await applyBarrier(condStdout, condIo, BarrierPolicy.STATUS)
      session.lastExitCode = condIo.exitCode
      if (breakOnZero && condIo.exitCode === 0) {
        hitLimit = false
        break
      }
      if (!breakOnZero && condIo.exitCode !== 0) {
        hitLimit = false
        break
      }
      try {
        const [stdout, io] = await executeBody(executeNode, body, session, stdin, callStack)
        allStdout.push(stdout)
        mergedIo = await mergedIo.merge(io)
      } catch (sig) {
        if (sig instanceof BreakSignal) {
          hitLimit = false
          if (sig.stdout !== null) allStdout.push(sig.stdout)
          mergedIo = await mergedIo.merge(sig.io)
          break
        }
        if (sig instanceof ContinueSignal) {
          if (sig.stdout !== null) allStdout.push(sig.stdout)
          mergedIo = await mergedIo.merge(sig.io)
          continue
        }
        throw sig
      }
    }

    if (hitLimit) {
      const warn = new TextEncoder().encode(
        `warning: ${label} loop terminated after ${MAX_WHILE.toString()} iterations\n`,
      )
      const existing = mergedIo.stderr
      if (existing instanceof Uint8Array && existing.byteLength > 0) {
        const combined = new Uint8Array(existing.byteLength + warn.byteLength)
        combined.set(existing, 0)
        combined.set(warn, existing.byteLength)
        mergedIo.stderr = combined
      } else {
        mergedIo.stderr = warn
      }
    }
    return collectLoopResult(allStdout, mergedIo, label)
  } finally {
    session.stdinBuffer = prevBuffer
  }
}

export function handleWhile(
  executeNode: ExecuteNodeFn,
  condition: TSNodeLike,
  body: readonly TSNodeLike[],
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  return conditionLoop(executeNode, condition, body, session, stdin, callStack, 'while', false)
}

export function handleUntil(
  executeNode: ExecuteNodeFn,
  condition: TSNodeLike,
  body: readonly TSNodeLike[],
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  return conditionLoop(executeNode, condition, body, session, stdin, callStack, 'until', true)
}

export async function handleCase(
  executeNode: ExecuteNodeFn,
  word: string,
  items: readonly [readonly string[], TSNodeLike | null][],
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  for (const [patterns, body] of items) {
    if (patterns.some((p) => fnmatch(word, p.trim()))) {
      if (body !== null) return executeNode(body, session, stdin, callStack)
      return [null, new IOResult(), new ExecutionNode({ command: 'case', exitCode: 0 })]
    }
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'case', exitCode: 0 })]
}

export function handleSelect(
  executeNode: ExecuteNodeFn,
  variable: string,
  values: readonly (string | PathSpec)[],
  body: readonly TSNodeLike[],
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  return handleFor(executeNode, variable, values, body, session, stdin, callStack).then(
    ([stdout, io]) =>
      [stdout, io, new ExecutionNode({ command: 'select', exitCode: io.exitCode })] as Result,
  )
}
