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

import type {
  Ask,
  CommandExplanation,
  Deny,
  Route,
  ShellExplanation,
  ShellNode,
  VfsExplanation,
} from '@struktoai/mirage-core/policy/types'
import type { JsonValue, Refusal } from '@struktoai/mirage-core/types'
import { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/workspace'

interface IoResultDict {
  kind: 'io'
  exit_code: number
  stdout: string
  stderr: string
  refusal: {
    kind: Refusal['kind']
    reason: string
    policy: string
    scope: Refusal['scope']
    ask_id: string | null
  } | null
}

interface RawResultDict {
  kind: 'raw'
  value: string
}

export type ResultDict = IoResultDict | RawResultDict

export function ioResultToDict(result: unknown): ResultDict & JsonValue {
  if (result instanceof ExecuteResult) {
    return {
      kind: 'io',
      exit_code: result.exitCode,
      stdout: result.stdoutText,
      stderr: result.stderrText,
      refusal:
        result.refusal === null
          ? null
          : {
              kind: result.refusal.kind,
              reason: result.refusal.reason,
              policy: result.refusal.policy,
              scope: result.refusal.scope,
              ask_id: result.refusal.askId,
            },
    }
  }
  return { kind: 'raw', value: String(result) }
}

/** One policy's answer as the server's doors carry it. Mirrors Python's `answer_to_dict`. */
function answerToDict(action: Deny | Ask | Route): Record<string, JsonValue> {
  if (action.kind === 'route') {
    return { kind: 'route', runtime: action.runtime, policy: action.policy ?? '' }
  }
  return { kind: action.kind, reason: action.reason, policy: action.policy ?? '' }
}

/**
 * An explanation as the server's doors answer it: a line with its tree
 * (`explain/shell`) or a VFS call (`explain/vfs/<call>`). Mirrors Python's
 * `explanation_to_dict`.
 */
export function explanationToDict(
  expl: ShellExplanation | VfsExplanation | CommandExplanation,
): Record<string, JsonValue> {
  const verdict: Record<string, JsonValue> = {
    outcome: expl.outcome,
    reason: expl.reason,
    source: expl.source,
    refusal:
      expl.refusal === null
        ? null
        : {
            kind: expl.refusal.kind,
            reason: expl.refusal.reason,
            policy: expl.refusal.policy,
            scope: expl.refusal.scope,
            ask_id: expl.refusal.askId,
          },
    answers: expl.answers.map(answerToDict),
  }
  if ('line' in expl) {
    return {
      line: expl.line,
      ...verdict,
      exit_code: expl.exitCode,
      stderr: expl.stderr,
      node: nodeToDict(expl.node),
    }
  }
  if ('call' in expl) {
    return { call: expl.call, paths: [...expl.paths], ...verdict, error: expl.error }
  }
  return {
    type: expl.type,
    text: expl.text,
    command: expl.command,
    argv: [...expl.argv],
    ...verdict,
    runtime: expl.runtime,
    operands: expl.operands.map((o) => ({ text: o.text, path: o.path, matched: o.matched })),
    children: expl.children.map(nodeToDict),
  }
}

/** One node of a line's tree as the doors carry it. Mirrors Python's `_node_to_dict`. */
function nodeToDict(node: ShellNode | CommandExplanation): Record<string, JsonValue> {
  if ('command' in node) return explanationToDict(node)
  return { type: node.type, text: node.text, children: node.children.map(nodeToDict) }
}
