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

function buildClient() {
  return makeClient(loadDaemonSettings())
}

export function registerJobCommands(program: Command): void {
  const job = program.command('job').description('Manage daemon jobs.')

  job
    .command('list')
    .option('-w, --workspace <id>')
    .action(async (opts: { workspace?: string }) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      const path =
        '/v1/jobs' + (opts.workspace !== undefined ? `?workspaceId=${opts.workspace}` : '')
      emit(await handleResponse(await c.request('GET', path)))
    })

  job
    .command('get')
    .argument('<id>')
    .action(async (id: string) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      const response = await handleResponse(await c.request('GET', `/v1/jobs/${id}`))
      emit(response)
      process.exit(exitCodeFromResponse(response))
    })

  job
    .command('wait')
    .argument('<id>')
    .option('--timeout <s>')
    .action(async (id: string, opts: { timeout?: string }) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      const body: Record<string, unknown> = {}
      if (opts.timeout !== undefined) body.timeoutS = Number(opts.timeout)
      const response = await handleResponse(
        await c.request('POST', `/v1/jobs/${id}/wait`, { body: JSON.stringify(body) }),
      )
      emit(response)
      process.exit(exitCodeFromResponse(response))
    })

  job
    .command('cancel')
    .argument('<id>')
    .action(async (id: string) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      emit(await handleResponse(await c.request('DELETE', `/v1/jobs/${id}`)))
    })
}
