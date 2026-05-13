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

import type { Command } from 'commander'
import { makeClient } from './client.ts'
import { emit, exitCodeFromResponse, handleResponse } from './output.ts'
import { loadDaemonSettings } from './settings.ts'

export function registerExecuteCommand(program: Command): void {
  program
    .command('execute')
    .description('Execute a command.')
    .requiredOption('-w, --workspace <id>', 'Workspace id')
    .requiredOption('-c, --command <command>', 'Shell command to execute')
    .option('-s, --session <id>', 'Session id')
    .option('--bg', 'Background; return job_id immediately')
    .action(
      async (opts: { workspace: string; command: string; session?: string; bg?: boolean }) => {
        const body: Record<string, unknown> = { command: opts.command, provision: false }
        if (opts.session !== undefined) body.sessionId = opts.session
        const path =
          `/v1/workspaces/${opts.workspace}/execute` + (opts.bg === true ? '?background=true' : '')
        const c = makeClient(loadDaemonSettings())
        await c.ensureRunning({ allowSpawn: false })
        const response = await handleResponse(
          await c.request('POST', path, { body: JSON.stringify(body) }),
        )
        emit(response)
        process.exit(exitCodeFromResponse(response))
      },
    )
}
