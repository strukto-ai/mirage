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

export interface PythonReplRunArgs {
  code: string
  sessionId: string
}

export type ReplStatus = 'complete' | 'incomplete' | 'exit'

export interface PythonReplRunResult {
  stdout: Uint8Array
  /** Captured standard error, null when empty (mirrors RunResult). */
  stderr: Uint8Array | null
  exitCode: number
  status: ReplStatus
}

export class PyodideUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PyodideUnavailableError'
  }
}
