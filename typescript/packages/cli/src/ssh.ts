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
import { fail } from './output.ts'
import { loadDaemonSettings } from './settings.ts'

/**
 * Carry SSH to a workspace over the server's HTTPS port, on stdio: for
 * `ssh -o ProxyCommand="mirage ssh-proxy %r" <id>@mirage`. The login is this
 * CLI's token, so no SSH key and no SSH port are needed.
 */
export function registerSshProxyCommand(program: Command): void {
  program
    .command('ssh-proxy')
    .argument('<workspace>', 'The workspace to log in to')
    .description("Carry SSH to a workspace over the server's HTTPS port, on stdio.")
    .action(async (workspace: string) => {
      const client = makeClient(loadDaemonSettings())
      try {
        await client.ensureRunning({ allowSpawn: true })
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
      }
      const base = client.settings.url
      const token = await client.token()
      const url = `ws${base.slice('http'.length)}/v1/workspaces/${encodeURIComponent(workspace)}/ssh`
      const headers: Record<string, string> =
        token === '' ? {} : { Authorization: `Bearer ${token}` }
      const { TunnelRefused, relaySsh } = await import('@struktoai/mirage-server/ssh/relay')
      try {
        await relaySsh(url, headers)
      } catch (error) {
        if (error instanceof TunnelRefused) fail(`ssh-proxy: ${error.message}`)
        throw error
      }
    })
}
