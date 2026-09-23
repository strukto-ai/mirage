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

import type { E2BRuntime } from '@struktoai/mirage-core/runtime/sandbox/e2b/runtime'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'

const dec = new TextDecoder()

async function waitForRemote(runtime: E2BRuntime, command: string): Promise<void> {
  const deadline = performance.now() + 10_000
  while (performance.now() < deadline) {
    const result = await runtime.runLine(command, null, {}, '/home/user')
    if (result.exitCode === 0) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Remote cancellation check did not reach the expected process state')
}

export async function exerciseCancellation(
  runtime: E2BRuntime,
  workspace: Workspace,
): Promise<void> {
  for (const mode of ['caller', 'timeout']) {
    const path = `/home/user/mirage-cancel-${crypto.randomUUID()}.pid`
    const command = `exec python3 -c 'import os,time; from pathlib import Path; Path("${path}").write_text(str(os.getpid())); time.sleep(60)'`
    const abort = new AbortController()
    const outcome = workspace.shell(command, { cwd: '/home/user', signal: abort.signal }).then(
      (result) => ({ code: result.exitCode, error: '' }),
      (error: unknown) => ({
        code: -1,
        error: error instanceof Error ? error.name : String(error),
      }),
    )
    try {
      await waitForRemote(runtime, `test -s ${path}`)
      const survivor = runtime.runLine('sleep 1; printf survivor', null, {}, '/home/user')
      if (mode === 'caller') abort.abort()
      const result = await outcome
      if (mode === 'caller' ? result.error !== 'AbortError' : result.code !== 124) {
        throw new Error(`Unexpected ${mode} cancellation result: ${JSON.stringify(result)}`)
      }
      await waitForRemote(runtime, `! kill -0 $(cat ${path}) 2>/dev/null`)
      if (dec.decode((await survivor).stdout) !== 'survivor')
        throw new Error('Cancellation affected a concurrent command')
    } finally {
      abort.abort()
      await outcome
      await runtime.runLine(
        `if test -s ${path}; then kill -9 $(cat ${path}) 2>/dev/null || true; fi; rm -f ${path}`,
        null,
        {},
        '/home/user',
      )
    }
  }
}
