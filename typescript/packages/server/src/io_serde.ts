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

import type { Ask, Deny, Explanation, Route } from '@struktoai/mirage-core/policy/types'
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

/** An explanation as the server's doors answer it. Mirrors Python's `explanation_to_dict`. */
export function explanationToDict(expl: Explanation): Record<string, JsonValue> {
  return {
    command: expl.command,
    argv: [...expl.argv],
    outcome: expl.outcome,
    reason: expl.reason,
    source: expl.source,
    matched_path: expl.matchedPath,
    paths: [...expl.paths],
    exit_code: expl.exitCode,
    stderr: expl.stderr,
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
    placement: expl.placement.map(answerToDict),
    runtime: expl.runtime,
    error: expl.error,
  }
}
