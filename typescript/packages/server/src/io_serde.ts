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
