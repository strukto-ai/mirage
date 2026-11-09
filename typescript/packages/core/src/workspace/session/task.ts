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

import { callerSignal } from '../../context/session_context.ts'
import { MemoryExhausted } from '../../io/errors.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import { PolicyDenied } from '../../policy/index.ts'
import type { Item, Shell, ShellTask, ShellTreeNode } from '../../rs/shell.ts'
import {
  ArithError,
  BadSubstitution,
  DiscardSignal,
  ExitSignal,
  ReadonlyVariableError,
  UnboundVariable,
} from '../../shell/errors.ts'
import type { EvaluationContext } from '../evaluation.ts'
import type { SessionState } from './session.ts'

/**
 * What a running shell task asks the host for, on the session whose shell the
 * task holds. Mirrors Python's TaskHost.
 */
export interface TaskHost {
  readonly session: SessionState
  readonly context: EvaluationContext
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
  /** Expand a subscript given as text, on the shell the task lent. */
  subscript(text: string): Promise<string>
  /**
   * Run the list a compound command picked, `test` when it is a test, on the
   * shell the task moved here, from statement `start`, those before it
   * having run on the shell and left `pending` in `$?`; `framed` when the
   * construct reads the session, so the shell is framed again after; `said`
   * what the construct said since the last list, which goes out first.
   * Answers its status, how it left, the levels of a `break` or `continue`,
   * and whether `set -e` is ending the shell.
   */
  run(
    index: number,
    test: boolean,
    start: number,
    pending: number | null,
    framed: boolean,
    said: readonly (string | Uint8Array)[],
  ): Promise<[number, string, number, boolean]>
}

function permissionDenied(name: string): PolicyDenied {
  return new PolicyDenied(`${name}: permission denied`, name)
}

/** The error an operation's stop throws. Mirrors Python's fault_error. */
export function faultError(fault: readonly Item[]): Error {
  const [tag] = fault
  switch (tag) {
    case 'hidden':
      return permissionDenied(fault[1] as string)
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
 * pause's view, or a copy of the child shell it hands on. A long list of
 * fields comes in slices, the host letting others run between them. Mirrors
 * Python's drive.
 */
export async function drive(
  task: ShellTask,
  host: TaskHost,
  diagnostics: (string | Uint8Array)[],
): Promise<Item> {
  let failure: unknown = undefined
  let failed = false
  let budget: YieldBudget | undefined
  const records = host.session.vars
  const shown = host.session.visibility
  for (let ask = task.step(); ask !== null; ask = task.step()) {
    const held = records.shell
    const moved = ask[0] === 'subscript' || ask[0] === 'run' ? ask[1] : null
    const lent = ask[0] === 'pause' || moved !== null ? ask[1] : ask[1].fork()
    records.shell = lent
    const giveUp = (): void => {
      if (moved === null) task.answerFailed()
      else if (ask[0] === 'run') task.answerRan(moved, 0, 'stop', 0, false)
      else task.answerSubscript(null, moved)
    }
    let answer = giveUp
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
        case 'subscript': {
          const text = await host.subscript(ask[2])
          answer = () => {
            task.answerSubscript(text, ask[1])
          }
          break
        }
        case 'run': {
          const ran = await host.run(ask[2], ask[3], ask[4], ask[5], ask[6], ask[7])
          answer = () => {
            task.answerRan(ask[1], ...ran)
          }
          break
        }
        default:
          budget ??= new YieldBudget(callerSignal(host.context))
          await budget.run()
          answer = () => {
            task.answerResumed()
          }
      }
    } catch (err) {
      failure = err
      failed = true
      answer = giveUp
    } finally {
      records.shell = held
      if (moved === null) lent.close()
    }
    // The copies the request lent are dropped ahead of the answer, so a
    // write the task lands shares its records with none and copies nothing.
    try {
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
  if (result[0] !== 'ok') throw faultError(result)
  if (!task.more()) return result[1] ?? null
  const fields = [...(result[1] as readonly Item[])]
  try {
    while (task.more()) {
      budget ??= new YieldBudget(callerSignal(host.context))
      await budget.run()
      fields.push(...task.slice())
    }
  } finally {
    task.close()
  }
  return fields
}
