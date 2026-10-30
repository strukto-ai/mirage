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

import { describe, expect, it } from 'vitest'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '@struktoai/mirage-node'
import { buildApp } from './app.ts'
import { ExecutionTable } from './jobs.ts'
import { CONTENT_TYPE, renderMetrics } from './metrics.ts'
import { WorkspaceRegistry } from './registry.ts'

describe('renderMetrics', () => {
  it('reads the registry and the responses', async () => {
    const registry = new WorkspaceRegistry({ maxWorkspaces: 4, idleGraceSeconds: 10 })
    registry.add(new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }), 'w')
    const text = renderMetrics(
      registry,
      new ExecutionTable(),
      1.5,
      new Map([
        [429, 1],
        [200, 3],
      ]),
    )
    const own = text
      .split('\n')
      .filter((line) => line !== '' && !/^(# (HELP|TYPE) )?process_/.test(line))
    expect(own).toEqual([
      '# HELP mirage_uptime_seconds Seconds since the server started.',
      '# TYPE mirage_uptime_seconds gauge',
      'mirage_uptime_seconds 1.5',
      '# HELP mirage_workspaces Workspaces the server holds.',
      '# TYPE mirage_workspaces gauge',
      'mirage_workspaces 1',
      '# HELP mirage_max_workspaces The most workspaces the server holds at once.',
      '# TYPE mirage_max_workspaces gauge',
      'mirage_max_workspaces 4',
      "# HELP mirage_sessions Sessions across the server's workspaces.",
      '# TYPE mirage_sessions gauge',
      'mirage_sessions 1',
      "# HELP mirage_jobs_running Lines the server's API is running.",
      '# TYPE mirage_jobs_running gauge',
      'mirage_jobs_running 0',
      '# HELP mirage_draining 1 while the server drains for shutdown, else 0.',
      '# TYPE mirage_draining gauge',
      'mirage_draining 0',
      '# HELP mirage_http_responses_total Responses the server sent, by status code.',
      '# TYPE mirage_http_responses_total counter',
      'mirage_http_responses_total{code="200"} 3',
      'mirage_http_responses_total{code="429"} 1',
    ])
    expect(text).toMatch(/\nprocess_resident_memory_bytes \d+\n$/)
    await registry.closeAll()
  })

  it('is served with every response the app sent counted', async () => {
    const app = buildApp()
    expect((await app.inject({ method: 'GET', url: '/v1/workspaces/nope' })).statusCode).toBe(404)
    const r = await app.inject({ method: 'GET', url: '/v1/metrics' })
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toBe(CONTENT_TYPE)
    expect(r.body).toContain('mirage_http_responses_total{code="404"} 1')
    await app.close()
  })
})
