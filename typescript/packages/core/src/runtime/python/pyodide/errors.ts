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

import { failureText } from './worker/failure.ts'

export class PyodideUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PyodideUnavailableError'
  }
}

/**
 * A run bound to a workspace with no worker to run it in. The guest reaches
 * the mounts only through the worker's synchronous bridge, so without one
 * every file of every mount would have to be copied in before each run.
 *
 * Args:
 *   cause: what stopped the worker from starting, absent when the host
 *     has no shared memory to start one with.
 */
export function noWorker(cause?: unknown): PyodideUnavailableError {
  if (cause === undefined) {
    return new PyodideUnavailableError(
      'pyodide reaches the workspace only from its worker, which needs SharedArrayBuffer (a cross-origin isolated page)',
    )
  }
  return new PyodideUnavailableError(`pyodide could not start its worker: ${failureText(cause)}`, {
    cause,
  })
}
