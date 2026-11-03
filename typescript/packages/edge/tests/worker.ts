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

import { createApp, MountMode, RAMVFS, Workspace } from '../src/index.ts'

const app = createApp({ maxWorkspaces: 32 })

interface Run {
  readonly lines: readonly string[]
  readonly maxMemory?: string
}

const decoder = new TextDecoder()

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/run') return app.fetch(request)
    const run = (await request.json()) as Run
    const ws = new Workspace(
      { '/data': new RAMVFS(), '/tmp': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        runtimes: ['workspace', 'monty'],
        ...(run.maxMemory !== undefined ? { maxMemory: run.maxMemory } : {}),
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
