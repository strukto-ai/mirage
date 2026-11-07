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

import { IOResult } from '../../../src/io/types.ts'
import { type JobResult, type JobRunner } from '../../../src/execution/job/index.ts'
import { ExecutionNode } from '../../../src/workspace/types.ts'

/** A runner that finishes immediately with no output. */
export const quiet: JobRunner = () =>
  Promise.resolve([new IOResult(), new ExecutionNode()] as JobResult)

/** A runner that never finishes on its own; only an abort ends it. */
export function pendingRun(abort: AbortController): JobRunner {
  return async () => {
    await new Promise<never>((_resolve, reject) => {
      abort.signal.addEventListener('abort', () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })
    throw new Error('unreachable')
  }
}
