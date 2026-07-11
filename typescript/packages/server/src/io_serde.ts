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

import { ExecuteResult } from '@struktoai/mirage-core'

interface IoResultDict {
  kind: 'io'
  exitCode: number
  stdout: string
  stderr: string
}

interface ProvisionResultDict {
  kind: 'provision'
  [k: string]: unknown
}

interface RawResultDict {
  kind: 'raw'
  value: string
}

export type ResultDict = IoResultDict | ProvisionResultDict | RawResultDict

export function ioResultToDict(result: unknown): ResultDict {
  if (result instanceof ExecuteResult) {
    return {
      kind: 'io',
      exitCode: result.exitCode,
      stdout: result.stdoutText,
      stderr: result.stderrText,
    }
  }
  if (typeof result === 'object' && result !== null) {
    return { kind: 'provision', ...(result as Record<string, unknown>) }
  }
  return { kind: 'raw', value: String(result) }
}
