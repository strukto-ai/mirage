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

import { callerSignal, explaining } from '../../context/session_context.ts'
import { MemoryExhausted } from '../../io/errors.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import {
  PolicyDenied,
  postSessionGate,
  preSessionGate,
  type Policies,
  type SessionContext,
} from '../../policy/index.ts'
import { DryRun } from '../../policy/types.ts'
import type { Item, Shell, ShellTask, ShellTreeNode } from '../../rs/shell.ts'
import {
  ArithError,
  BadSubstitution,
  DiscardSignal,
  ExitSignal,
  ReadonlyVariableError,
  UnboundVariable,
} from '../../shell/errors.ts'
import type { SessionState } from './session.ts'

/**
 * What a running shell task asks the host for, on the session whose shell the
 * task holds. Mirrors Python's TaskHost.
 */
export interface TaskHost {
  readonly session: SessionState
  /**
   * Run a command substitution's body in the child `shell`, a copy of the
   * task's; `span` is the body's span within the node, for a backtick region
   * holding several, and `read` the words the task's shell expanded the file
   * of `$(< file)` to, glob marks kept; any but one is an ambiguous redirect.
   */
  substitute(
    shell: Shell,
    body: string,
    node: ShellTreeNode,
    span: readonly [number, number] | null,
    read: readonly string[] | null,
  ): Promise<[Uint8Array, Uint8Array, number]>
  /** Start a process substitution in `shell` and name its pipe. */
  process(shell: Shell, node: ShellTreeNode): Promise<string>
  /**
   * Ask the session policies about one write (`post` after it landed); a
   * refusal throws. The session reads as the write finds it while they answer.
   */
  gate(
    post: boolean,
    verb: string,
    key: string,
    value: string | null,
    old: string | null,
  ): Promise<void>
  /** Whether a policy hears the session's writes now, told to a task again each time the host answers it. */
  listens(): Promise<boolean>
}

/**
 * Whether a session write asks anyone: a policy that hears this session's
 * writes, or a dry run deciding, which refuses every write. A profile's
 * programs speak for its own sessions only, so a session none governs writes
 * without a gate, and an element write lands in place. Mirrors Python's
 * listens.
 */
export async function listens(policies: Policies | null, sessionId: string): Promise<boolean> {
  if (explaining() === DryRun.DECIDING) return true
  return (
    policies !== null &&
    ((await policies.wantsFor('preSession', sessionId)) ||
      (await policies.wantsFor('postSession', sessionId)))
  )
}

/**
 * A task host that gates writes on one session's policies and runs nothing:
 * a builtin's write, or arithmetic. Mirrors Python's SessionGate.
 */
export class SessionGate implements TaskHost {
  constructor(
    readonly session: SessionState,
    readonly policies: Policies | null,
  ) {}

  substitute(): Promise<[Uint8Array, Uint8Array, number]> {
    return Promise.reject(new Error('a write runs no substitution'))
  }

  process(): Promise<string> {
    return Promise.reject(new Error('a write runs no process substitution'))
  }

  async gate(
    post: boolean,
    verb: string,
    key: string,
    value: string | null,
    old: string | null,
  ): Promise<void> {
    const ctx: SessionContext = { verb, key, value, sessionId: this.session.sessionId }
    if (post) await postSessionGate(this.policies, ctx, old)
    else await preSessionGate(this.policies, ctx)
  }

  listens(): Promise<boolean> {
    return listens(this.policies, this.session.sessionId)
  }
}

function permissionDenied(name: string): PolicyDenied {
  return new PolicyDenied(`${name}: permission denied`, name)
}

/** The error an operation's stop throws. Mirrors Python's fault_error. */
export function faultError(fault: readonly Item[], refusals: Map<number, Error>): Error {
  const [tag] = fault
  switch (tag) {
    case 'hidden':
      return permissionDenied(fault[1] as string)
    case 'denied':
      return refusals.get(fault[2] as number) ?? permissionDenied(fault[1] as string)
    case 'readonly':
      return new ReadonlyVariableError(fault[1] as string, fault[2] as boolean)
    case 'arith': {
      const stop = fault[1] as readonly Item[]
      if (stop[0] === 'arith') {
        const error = new ArithError(stop[1] as string, stop[2] as string, stop[3] as string | null)
        error.inSubscript = stop[4] as boolean
        return error
      }
      if (stop[0] === 'readonly')
        return new ReadonlyVariableError(stop[1] as string, stop[2] as boolean)
      if (stop[0] === 'unbound') return new UnboundVariable(stop[1] as string)
      break
    }
    case 'exit':
      return new ExitSignal(fault[1] as number, fault[2] as Uint8Array, null, fault[3] as number)
    case 'discard':
      return new DiscardSignal(fault[1] as Uint8Array, fault[2] as number)
    case 'bad':
      return new BadSubstitution(fault[1] as string).within(fault[1] as string, fault[2] as boolean)
    case 'memory':
      return new MemoryExhausted()
    default:
      break
  }
  return new Error(
    `shell task stopped: ${JSON.stringify(fault, (_, v: unknown) => (typeof v === 'bigint' ? String(v) : v))}`,
  )
}

/**
 * Run a task to its end, answering what it asks. A failure of the host's
 * stops the task and throws once the shell is back with its owner; so does
 * the task's own stop. Its warnings go to `diagnostics`, in order, whether it
 * ends or stops. The session's own shell is the task's until it ends, so while
 * the host answers, whatever reads the session by its id (a policy's view, a
 * call forking it, the store's flush) reads a copy as the task left it: the
 * request's view, or a copy of the child shell it hands on. A long list of
 * fields comes in slices, the host letting others run between them. Mirrors
 * Python's drive.
 */
export async function drive(
  task: ShellTask,
  host: TaskHost,
  diagnostics: (string | Uint8Array)[],
): Promise<Item> {
  const refusals = new Map<number, Error>()
  let failure: unknown = undefined
  let failed = false
  let budget: YieldBudget | undefined
  const records = host.session.vars
  const shown = host.session.visibility
  for (let ask = task.step(); ask !== null; ask = task.step()) {
    const held = records.shell
    const lent = ask[0] === 'gate' ? ask[6] : ask[0] === 'pause' ? ask[1] : ask[1].fork()
    records.shell = lent
    let answer = (): void => {
      task.answerFailed()
    }
    let heard: boolean | null = null
    try {
      switch (ask[0]) {
        case 'substitute': {
          try {
            const [stdout, stderr, status] = await host.substitute(
              ask[1],
              ask[2],
              ask[3],
              ask[4],
              ask[5],
            )
            answer = () => {
              task.answerSubstituted(stdout, stderr, status)
            }
          } finally {
            // The child shell ends with its substitution.
            ask[1].close()
          }
          break
        }
        case 'process': {
          const path = await host.process(ask[1], ask[2])
          answer = () => {
            task.answerPath(path)
          }
          break
        }
        case 'gate': {
          const [, post, verb, key, value, old] = ask
          try {
            await host.gate(post, verb, key, value, old)
          } catch (err) {
            if (!(err instanceof PolicyDenied)) throw err
            const record = refusals.size + 1
            refusals.set(record, err)
            answer = () => {
              task.answerGate([key, record])
            }
            break
          }
          answer = () => {
            task.answerGate(null)
          }
          break
        }
        default:
          budget ??= new YieldBudget(callerSignal())
          await budget.run()
          answer = () => {
            task.answerResumed()
          }
      }
      // Asked while the lent copy stands in for the session, so a policy
      // reading the session to answer finds one to read.
      heard = await host.listens()
    } catch (err) {
      failure = err
      failed = true
      answer = () => {
        task.answerFailed()
      }
    } finally {
      records.shell = held
      lent.close()
    }
    // The copies the request lent are dropped ahead of the answer, so a
    // write the task lands shares its records with none and copies nothing;
    // a policy added while the host answered hears what comes next.
    try {
      if (heard !== null) task.listen(heard)
      answer()
    } catch (err) {
      failure = err
      failed = true
      task.answerFailed()
    }
  }
  const [result, said] = task.finish()
  // A profile changed while the host answered hid its names on a copy lent
  // meanwhile; the shell, back with its owner, takes them now.
  if (host.session.visibility !== shown) host.session.hideVars()
  diagnostics.push(...said)
  if (failed) throw failure
  if (result[0] !== 'ok') throw faultError(result, refusals)
  if (!task.more()) return result[1] ?? null
  const fields = [...(result[1] as readonly Item[])]
  try {
    while (task.more()) {
      budget ??= new YieldBudget(callerSignal())
      await budget.run()
      fields.push(...task.slice())
    }
  } finally {
    task.close()
  }
  return fields
}
