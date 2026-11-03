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

import { networkRule, runWithNetwork } from '@struktoai/mirage-core/io/network'
import { Limit } from '@struktoai/mirage-core/types'
import { createApp, MountMode, RAMVFS, Workspace } from '../src/index.ts'

const app = createApp({ maxWorkspaces: 32 })

interface Run {
  readonly lines: readonly string[]
  readonly maxMemory?: string
  readonly lineSeconds?: number
}

interface Follow {
  readonly url: string
  readonly allowed: readonly string[]
}

/** `follow.url` fetched as a mount's client fetches, under a workspace's rule. */
async function follow({ url, allowed }: Follow): Promise<Response> {
  const network = { allowed_domains: allowed }
  const ws = new Workspace({ '/': new RAMVFS() }, { network })
  try {
    const response = await runWithNetwork(networkRule(network), () => fetch(url))
    return Response.json({ status: response.status, body: await response.text() })
  } catch (e) {
    return Response.json({ error: String(e) })
  } finally {
    await ws.close()
  }
}

const decoder = new TextDecoder()

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/follow') return follow((await request.json()) as Follow)
    if (pathname !== '/run') return app.fetch(request)
    const run = (await request.json()) as Run
    const ws = new Workspace(
      { '/data': new RAMVFS(), '/tmp': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        runtimes: ['workspace', 'monty'],
        ...(run.maxMemory !== undefined ? { maxMemory: run.maxMemory } : {}),
        ...(run.lineSeconds !== undefined
          ? { commandLimits: { '@line': new Limit({ timeoutSeconds: run.lineSeconds }) } }
          : {}),
      },
    )
    try {
      const results = []
      for (const line of run.lines) {
        const result = await ws.shell(line)
        results.push({
          exit: result.exitCode,
          stdout: decoder.decode(result.stdout),
          stderr: decoder.decode(result.stderr),
        })
      }
      return Response.json(results)
    } finally {
      await ws.close()
    }
  },
}
