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

import { seedVar } from '../session/state.ts'
import { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import { asyncChain } from '../../io/stream.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult } from '../../io/types.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import { type Policies } from '../../policy/index.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import { ArithError, ReadonlyError } from '../../shell/errors.ts'
import { finishStatement, recordStatus } from './statement.ts'
import { pipelineTransparent } from '../../shell/node_kind.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ERREXIT_EXEMPT_TYPES } from '../../shell/constants.ts'
import type { PathSpec } from '../../types.ts'
import { wordText } from '../../types.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { Session } from '../session/session.ts'
import { sessionView } from '../session/state.ts'
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
  readonly levels: number
  constructor(stdout: ByteSource | null = null, io: IOResult = new IOResult(), levels = 1) {
    super('break')
    this.name = 'BreakSignal'
    this.stdout = stdout
    this.io = io
    this.levels = levels
  }
}

export class ContinueSignal extends Error {
  readonly stdout: ByteSource | null
  readonly io: IOResult
  readonly levels: number
  constructor(stdout: ByteSource | null = null, io: IOResult = new IOResult(), levels = 1) {
    super('continue')
    this.name = 'ContinueSignal'
    this.stdout = stdout
    this.io = io
    this.levels = levels
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
      const [rawStdout, io, execNode] = await executeNode(cmd, session, stdin, callStack)
      lastExec = execNode
      const stdout = await finishStatement(rawStdout, io, session, cmd)
      allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
      if (
        io.exitCode !== 0 &&
        session.shellOptions.errexit === true &&
        !ERREXIT_EXEMPT_TYPES.has(cmd.type) &&
        !session.errexitImmune
      ) {
        mergedIo.exitCode = io.exitCode
        break
      }
    } catch (sig) {
      if (sig instanceof BreakSignal) {
        // The control builtin is a statement the loop leaves through
        // rather than closes, so its own status (0) is recorded here:
        // bash leaves `${PIPESTATUS[@]}` at `0` after `break`.
        recordStatus(session, 0)
        if (sig.stdout !== null) allStdout.push(sig.stdout)
        mergedIo = await mergedIo.merge(sig.io)
        const combined = chainNonNull(allStdout)
        throw new BreakSignal(combined, mergedIo, sig.levels)
      }
      if (sig instanceof ContinueSignal) {
        recordStatus(session, 0)
        if (sig.stdout !== null) allStdout.push(sig.stdout)
        mergedIo = await mergedIo.merge(sig.io)
        const combined = chainNonNull(allStdout)
        throw new ContinueSignal(combined, mergedIo, sig.levels)
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
    recordStatus(session, condIo.exitCode, pipelineTransparent(condition))
    if (condIo.exitCode === 0) {
      return executeBody(executeNode, body, session, stdin, callStack)
    }
  }
  if (elseBody !== null) {
    return executeBody(executeNode, elseBody, session, stdin, callStack)
  }
  return [null, new IOResult(), new ExecutionNode({ exitCode: 0 })]
}

// `set -n` inside a loop body has to stop the *driver* too, not only the
// statements: `executeNode` refuses every node while the option is on, so
// the `break` or the false condition the driver is waiting for is one of
// the refused nodes and it would spin to MAX_WHILE. GNU never runs the
// loop at all, which is what falling straight out of it produces.
export async function handleFor(
  executeNode: ExecuteNodeFn,
  variable: string,
  values: readonly (string | PathSpec)[],
  body: readonly TSNodeLike[],
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  policies: Policies | null = null,
): Promise<Result> {
  let mergedIo = new IOResult()
  const allStdout: (ByteSource | null)[] = []
  const view = sessionView(session, policies)
  // The loop variable is the shell's own write: readonly is bash's
  // rule, checked up front so the loop never starts, exactly as bash
  // refuses `for x` on a readonly x before the first iteration.
  if (view.isReadonly(variable)) {
    const err = new TextEncoder().encode(`bash: ${variable}: readonly variable\n`)
    return collectLoopResult([], new IOResult({ exitCode: 1, stderr: err }), 'for')
  }
  const savedValue = session.env[variable]
  const hadKey = variable in session.env
  const [prevBuffer, bodyStdin] = installStdinBuffer(session, stdin)
  stdin = bodyStdin

  try {
    for (const val of values) {
      if (session.shellOptions.noexec === true) break
      // env stores strings only; bash keeps `for f in sub/*.txt`
      // matches relative, so the loop variable takes the typed form.
      // The write goes through the session door; a policy denial
      // aborts the loop before its body runs.
      const textVal = wordText(val)
      try {
        await view.set(variable, textVal)
      } catch (err) {
        if (!(err instanceof PolicyDenied)) throw err
        mergedIo = await mergedIo.merge(
          new IOResult({ exitCode: 1, stderr: new TextEncoder().encode(`${err.message}\n`) }),
        )
        break
      }
      try {
        const [stdout, io] = await executeBody(executeNode, body, session, stdin, callStack)
        allStdout.push(stdout)
        mergedIo = await mergedIo.merge(io)
      } catch (sig) {
        if (sig instanceof BreakSignal) {
          if (sig.stdout !== null) allStdout.push(sig.stdout)
          mergedIo = await mergedIo.merge(sig.io)
          if (sig.levels > 1) {
            throw new BreakSignal(chainNonNull(allStdout), mergedIo, sig.levels - 1)
          }
          break
        }
        if (sig instanceof ContinueSignal) {
          if (sig.stdout !== null) allStdout.push(sig.stdout)
          mergedIo = await mergedIo.merge(sig.io)
          if (sig.levels > 1) {
            throw new ContinueSignal(chainNonNull(allStdout), mergedIo, sig.levels - 1)
          }
          continue
        }
        throw sig
      }
    }
  } finally {
    if (hadKey && savedValue !== undefined) {
      seedVar(session, variable, savedValue)
    } else {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete session.vars[variable]
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
      if (session.shellOptions.noexec === true) {
        hitLimit = false
        break
      }
      const [condStdout, condIo] = await executeNode(condition, session, stdin, callStack)
      await applyBarrier(condStdout, condIo, BarrierPolicy.STATUS)
      recordStatus(session, condIo.exitCode, pipelineTransparent(condition))
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
          if (sig.levels > 1) {
            throw new BreakSignal(chainNonNull(allStdout), mergedIo, sig.levels - 1)
          }
          break
        }
        if (sig instanceof ContinueSignal) {
          if (sig.stdout !== null) allStdout.push(sig.stdout)
          mergedIo = await mergedIo.merge(sig.io)
          if (sig.levels > 1) {
            throw new ContinueSignal(chainNonNull(allStdout), mergedIo, sig.levels - 1)
          }
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

export type CforEval = (exprs: readonly TSNodeLike[], dflt: number) => Promise<number>

/**
 * Run bash's C-style for: ((init; cond; update)) around a body.
 *
 * `evalExpr` evaluates one expression slot to its integer value (the
 * default when the slot is empty) and throws ArithError with the
 * offending expression text on an invalid expression, or ReadonlyError
 * when it assigns to a readonly variable; bash aborts the loop with
 * status 1, keeping the output of iterations that ran. The update
 * expression still runs after `continue`, per bash.
 */
export async function handleCfor(
  executeNode: ExecuteNodeFn,
  exprs: readonly (readonly TSNodeLike[])[],
  body: readonly TSNodeLike[],
  evalExpr: CforEval,
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  let mergedIo = new IOResult()
  const allStdout: (ByteSource | null)[] = []
  let hitLimit = true
  const [prevBuffer, bodyStdin] = installStdinBuffer(session, stdin)
  stdin = bodyStdin

  try {
    try {
      await evalExpr(exprs[0] ?? [], 0)
      for (let i = 0; i < MAX_WHILE; i++) {
        if (session.shellOptions.noexec === true) {
          hitLimit = false
          break
        }
        if ((await evalExpr(exprs[1] ?? [], 1)) === 0) {
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
            if (sig.levels > 1) {
              throw new BreakSignal(chainNonNull(allStdout), mergedIo, sig.levels - 1)
            }
            break
          }
          if (sig instanceof ContinueSignal) {
            if (sig.stdout !== null) allStdout.push(sig.stdout)
            mergedIo = await mergedIo.merge(sig.io)
            if (sig.levels > 1) {
              throw new ContinueSignal(chainNonNull(allStdout), mergedIo, sig.levels - 1)
            }
            await evalExpr(exprs[2] ?? [], 0)
            continue
          }
          throw sig
        }
        await evalExpr(exprs[2] ?? [], 0)
      }
    } catch (err) {
      // PolicyDenied is a header expression assigning a hidden name,
      // refused by the same door as any denied assignment.
      if (
        !(err instanceof ArithError) &&
        !(err instanceof ReadonlyError) &&
        !(err instanceof PolicyDenied)
      ) {
        throw err
      }
      const prefix = err instanceof ArithError ? 'bash: ((: ' : 'bash: '
      const errBytes = new TextEncoder().encode(`${prefix}${err.message}\n`)
      mergedIo = await mergedIo.merge(new IOResult({ exitCode: 1, stderr: errBytes }))
      mergedIo.exitCode = 1
      return collectLoopResult(allStdout, mergedIo, 'for')
    }
    if (hitLimit) {
      const warn = new TextEncoder().encode(
        `warning: for loop terminated after ${MAX_WHILE.toString()} iterations\n`,
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
    return collectLoopResult(allStdout, mergedIo, 'for')
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
  items: readonly [readonly string[], readonly TSNodeLike[], string][],
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  const allStdout: ByteSource[] = []
  let mergedIo = new IOResult()
  let lastExec = new ExecutionNode({ command: 'case', exitCode: 0 })
  let stageStdin = stdin
  let ran = false
  let fallthrough = false
  for (const [patterns, body, terminator] of items) {
    if (!(fallthrough || patterns.some((p) => fnmatch(word, p)))) continue
    ran = true
    for (const stmt of body) {
      const [rawStdout, io, execNode] = await executeNode(stmt, session, stageStdin, callStack)
      stageStdin = null
      lastExec = execNode
      const stdout = await finishStatement(rawStdout, io, session, stmt)
      if (stdout !== null) allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
    }
    if (terminator === ';&') {
      // Fall through: run the next arm's body without testing it.
      fallthrough = true
      continue
    }
    // ;;& keeps testing remaining patterns; ;; stops here.
    fallthrough = false
    if (terminator !== ';;&') break
  }
  if (!ran) return [null, new IOResult(), new ExecutionNode({ command: 'case', exitCode: 0 })]
  const first = allStdout[0]
  if (allStdout.length === 1 && first !== undefined) return [first, mergedIo, lastExec]
  const combined = allStdout.length > 0 ? asyncChain(...allStdout) : null
  return [combined, mergedIo, lastExec]
}

/**
 * Run bash's select loop: menu to stderr, choice read from stdin.
 *
 * Each iteration prompts with PS3's default `#? `, reads one line,
 * stores it raw in REPLY, and sets the variable to the chosen value
 * (empty for an out-of-range or non-numeric reply, like bash). An
 * empty reply redisplays the menu without running the body; EOF ends
 * the loop.
 */
export async function handleSelect(
  executeNode: ExecuteNodeFn,
  variable: string,
  values: readonly (string | PathSpec)[],
  body: readonly TSNodeLike[],
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  policies: Policies | null = null,
): Promise<Result> {
  let mergedIo = new IOResult()
  const allStdout: (ByteSource | null)[] = []
  const view = sessionView(session, policies)
  const savedValue = session.env[variable]
  const hadKey = variable in session.env
  const [prevBuffer, bodyStdin] = installStdinBuffer(session, stdin)
  stdin = bodyStdin

  const menu = new TextEncoder().encode(
    values.map((v, i) => `${(i + 1).toString()}) ${wordText(v)}\n`).join(''),
  )
  mergedIo = await mergedIo.merge(new IOResult({ stderr: menu }))
  try {
    for (let i = 0; i < MAX_WHILE; i++) {
      if (session.shellOptions.noexec === true) break
      mergedIo = await mergedIo.merge(new IOResult({ stderr: new TextEncoder().encode('#? ') }))
      const lineBytes = session.stdinBuffer !== null ? await session.stdinBuffer.readline() : null
      if (lineBytes === null) {
        // bash terminates the prompt line with a newline when the
        // choice read hits EOF.
        allStdout.push(new TextEncoder().encode('\n'))
        break
      }
      const reply = new TextDecoder().decode(lineBytes).replace(/\n$/, '')
      if (reply === '') {
        mergedIo = await mergedIo.merge(new IOResult({ stderr: menu }))
        continue
      }
      let choice = ''
      if (/^\d+$/.test(reply.trim())) {
        const idx = parseInt(reply.trim(), 10)
        if (idx >= 1 && idx <= values.length) {
          choice = wordText(values[idx - 1] ?? '')
        }
      }
      // REPLY and the select variable are session writes, so they clear
      // the preSession gate like the for-loop variable.
      // REPLY and the select variable go through the session door like
      // the for-loop variable; readonly is the shell's own rule,
      // checked before the door is asked.
      const frozen = ['REPLY', variable].find((n) => view.isReadonly(n))
      if (frozen !== undefined) {
        const err = new TextEncoder().encode(`bash: ${frozen}: readonly variable\n`)
        mergedIo = await mergedIo.merge(new IOResult({ exitCode: 1, stderr: err }))
        break
      }
      try {
        await view.set('REPLY', reply)
        await view.set(variable, choice)
      } catch (err) {
        if (!(err instanceof PolicyDenied)) throw err
        mergedIo = await mergedIo.merge(
          new IOResult({ exitCode: 1, stderr: new TextEncoder().encode(`${err.message}\n`) }),
        )
        break
      }
      try {
        const [stdout, io] = await executeBody(executeNode, body, session, null, callStack)
        allStdout.push(stdout)
        mergedIo = await mergedIo.merge(io)
      } catch (sig) {
        if (sig instanceof BreakSignal) {
          if (sig.stdout !== null) allStdout.push(sig.stdout)
          mergedIo = await mergedIo.merge(sig.io)
          if (sig.levels > 1) {
            throw new BreakSignal(chainNonNull(allStdout), mergedIo, sig.levels - 1)
          }
          break
        }
        if (sig instanceof ContinueSignal) {
          if (sig.stdout !== null) allStdout.push(sig.stdout)
          mergedIo = await mergedIo.merge(sig.io)
          if (sig.levels > 1) {
            throw new ContinueSignal(chainNonNull(allStdout), mergedIo, sig.levels - 1)
          }
          continue
        }
        throw sig
      }
    }
  } finally {
    if (hadKey && savedValue !== undefined) {
      seedVar(session, variable, savedValue)
    } else {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete session.vars[variable]
    }
    session.stdinBuffer = prevBuffer
  }
  return collectLoopResult(allStdout, mergedIo, 'select')
}

export class ReturnSignal extends Error {
  readonly exitCode: number
  readonly stderr: Uint8Array
  constructor(exitCode: number, stderr: Uint8Array = new Uint8Array()) {
    super('return')
    this.name = 'ReturnSignal'
    this.exitCode = exitCode
    this.stderr = stderr
  }
}
