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

import type { IOResult } from '../../io/types.ts'
import type { Policies } from '../../policy/index.ts'
import { ShellVars } from '../../rs/session.ts'
import type { Item, Shell, ShellTreeNode } from '../../rs/shell.ts'
import { CallStack } from '../../shell/call_stack.ts'
import { ProgramNode, type ParsedProgram, shellNode } from '../../shell/parse/program.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { markGlobs } from '../../utils/glob_walk.ts'
import { childContext, type EvaluationContext } from '../evaluation.ts'
import { recordStatus } from '../executor/statement.ts'
import type { ProcessSubLine } from '../frame.ts'
import type { SessionState } from '../session/session.ts'
import { frame } from '../session/state.ts'
import { SessionGate, drive, listens, type TaskHost } from '../session/task.ts'
import type { ExecuteFn } from './types.ts'

/**
 * Run a substitution's line in a child shell.
 *
 * The line reaches the executor unwrapped, under the node that named it,
 * so the pass places its commands where they were typed rather than under
 * a subshell of their own. The child runs on a copy of the caller's frames:
 * inside a function it reads the function's `$1`, `return` ends it, and so
 * does a `break` from a loop the caller is in. `span` is the pair's span
 * within the node, for a backtick region holding several; `records` the
 * child shell's variables, the copy the expansion made where the
 * substitution stood.
 */
export async function childLine(
  context: EvaluationContext,
  executeFn: ExecuteFn,
  text: string,
  node: TSNodeLike,
  callStack: CallStack | null,
  span?: readonly [number, number] | null,
  options: NonNullable<Parameters<ProcessSubLine>[1]> & { records?: ShellVars; read?: string } = {},
): Promise<IOResult> {
  const session = context.session
  return executeFn(text, {
    ...options,
    sessionId: session.sessionId,
    context,
    node,
    substitution: true,
    callStack: (callStack ?? new CallStack()).fork(true, false),
    ...(span === undefined || span === null ? {} : { span }),
  })
}

/**
 * What a word's expansion asks of the shell running it: a command
 * substitution's line, a process substitution's pipe, and the session
 * policies on the writes it makes. Mirrors Python's ExpandHost.
 */
export class ExpandHost implements TaskHost {
  private readonly gates: SessionGate
  private readonly program: ParsedProgram | null
  readonly session: SessionState

  constructor(
    readonly context: EvaluationContext,
    readonly executeFn: ExecuteFn,
    readonly callStack: CallStack | null,
    policies: Policies | null,
    word: TSNodeLike,
  ) {
    this.session = context.session
    this.gates = new SessionGate(context.session, policies)
    this.program = word instanceof ProgramNode ? word.program : null
  }

  private node(node: ShellTreeNode): TSNodeLike {
    return this.program === null ? node : new ProgramNode(node, this.program)
  }

  async substitute(
    shell: Shell,
    body: string,
    node: ShellTreeNode,
    span: readonly [number, number] | null,
    read: string | null,
  ): Promise<[Uint8Array, Uint8Array, number]> {
    const context = this.context
    const io = await childLine(context, this.executeFn, body, this.node(node), this.callStack, span, {
      records: new ShellVars(shell),
      ...(read === null ? {} : { read }),
    })
    const stdout = await io.materializeStdout()
    const stderr = await io.materializeStderr()
    // An assignment-only statement whose value ran substitutions reports the
    // last one's status as its own, and `$?` reads it in the words that
    // follow (`false; echo $(true) $?` prints 0).
    context.frame.cmdsubSeq += 1
    context.frame.cmdsubStatus = io.exitCode
    recordStatus(context.session, io.exitCode, true)
    return [stdout, stderr, io.exitCode]
  }

  async process(shell: Shell, node: ShellTreeNode): Promise<string> {
    const context = this.context
    const named = this.node(node)
    const processSub = context.frame.processSub
    if (processSub === null) return named.text
    // The child shell is taken where the word expands, its function's
    // locals included, so the substitution sees the shell as it stood then
    // while the command naming it goes on.
    const child = childContext(context, new ShellVars(shell))
    return processSub(named, (text, options) =>
      childLine(child, this.executeFn, text, named, this.callStack, null, options),
    )
  }

  gate(
    post: boolean,
    verb: string,
    key: string,
    value: string | null,
    old: string | null,
  ): Promise<void> {
    return this.gates.gate(post, verb, key, value, old)
  }
}

function literal(node: TSNodeLike): string {
  let at = node
  while (at.type !== 'raw_string' && at.children[0] !== undefined) at = at.children[0]
  return at.type === 'raw_string' ? at.text.slice(1, -1) : at.text
}

/**
 * Expand one word on the session's shell, as `mode` reads it: `fields`
 * (argument words, each glob-ready with quoting as marks), `text` (nothing
 * splits), `assignment`, `pattern` (runs, each quoted or live), `regex` or
 * `arith` (the expression text).
 */
export async function expand(
  word: TSNodeLike,
  mode: string,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
  policies: Policies | null = null,
): Promise<Item> {
  const node = shellNode(word)
  if (node === null) {
    const text = literal(word)
    if (mode === 'fields') return [markGlobs(text)]
    return mode === 'pattern' ? [[text, true]] : text
  }
  const session = context.session
  frame(session, callStack)
  const task = session.vars.shell.expand(node, mode, listens(policies))
  const host = new ExpandHost(context, executeFn, callStack, policies, word)
  return drive(task, host, context.frame.diagnostics)
}

/**
 * Expand a parsed node to the string it stands for, where nothing splits:
 * a splat reads as its elements joined (`$@` on a space, `$*` on IFS's
 * first character).
 */
export async function expandNode(
  tsNode: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
  policies: Policies | null = null,
): Promise<string> {
  return (await expand(tsNode, 'text', context, executeFn, callStack, policies)) as string
}

/**
 * An assignment's value, where nothing splits and a tilde prefix expands at
 * its start and after each unquoted `:` (`PATH=/a:~/b`).
 */
export async function expandAssignment(
  tsNode: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
  policies: Policies | null = null,
): Promise<string> {
  return (await expand(tsNode, 'assignment', context, executeFn, callStack, policies)) as string
}

/**
 * An arithmetic command's expression text: `$`-expansions substitute
 * textually, as bash expands before it evaluates, while bare names stay
 * names for the evaluator to read and assign.
 */
export async function expandArith(
  tsNode: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  policies: Policies | null = null,
): Promise<string> {
  return (await expand(tsNode, 'arith', context, executeFn, callStack, policies)) as string
}
