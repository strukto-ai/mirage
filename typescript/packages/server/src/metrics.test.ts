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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '@struktoai/mirage-node'
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics'
import { buildApp } from './app.ts'
import * as metrics from './metrics.ts'
import { WorkspaceRegistry } from './registry.ts'

class Reader extends MetricReader {
  protected onShutdown(): Promise<void> {
    return Promise.resolve()
  }

  protected onForceFlush(): Promise<void> {
    return Promise.resolve()
  }
}

async function read(reader: Reader): Promise<Record<string, [unknown, unknown][]>> {
  const { resourceMetrics } = await reader.collect()
  const seen: Record<string, [unknown, unknown][]> = {}
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      seen[metric.descriptor.name] = metric.dataPoints.map((point) => [
        point.attributes,
        point.value,
      ])
    }
  }
  return seen
}

describe('metrics', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads the registered registries', async () => {
    const reader = new Reader()
    const refusals = metrics.create(new MeterProvider({ readers: [reader] }).getMeter('t'))
    const registry = new WorkspaceRegistry({ maxWorkspaces: 4, idleGraceSeconds: 10 })
    registry.add(new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }), 'w')
    const unregister = metrics.registerMetrics(registry)
    refusals.add(1, { reason: 'rate_limit' })
    const got = await read(reader)
    expect(got['mirage.workspace.count']).toEqual([[{}, 1]])
    expect(got['mirage.workspace.limit']).toEqual([[{}, 4]])
    expect(got['mirage.session.count']).toEqual([[{}, 1]])
    expect(got['mirage.job.running']).toEqual([[{}, 0]])
    expect(got['mirage.server.draining']).toEqual([[{}, 0]])
    expect(got['mirage.request.refused']).toEqual([[{ reason: 'rate_limit' }, 1]])
    await registry.drain(0)
    expect((await read(reader))['mirage.server.draining']).toEqual([[{}, 1]])
    unregister()
    expect((await read(reader))['mirage.workspace.count']).toEqual([[{}, 0]])
    await registry.closeAll()
  })

  it('counts what the server refuses', async () => {
    const reasons: string[] = []
    const reader = new Reader()
    const refusals = metrics.create(new MeterProvider({ readers: [reader] }).getMeter('t2'))
    vi.spyOn(refusals, 'add').mockImplementation((_value, attributes) => {
      reasons.push(String(attributes?.reason))
    })
    vi.spyOn(metrics, 'refused').mockImplementation((reason) => {
      refusals.add(1, { reason })
    })
    const app = buildApp({
      maxSessions: 1,
      maxWorkspaces: 1,
      rateLimits: [{ key: 'header:x-tenant', rate: '1/minute' }],
    })
    const config = { config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } }
    const busy = { 'x-tenant': 'a' }
    await app.inject({ method: 'GET', url: '/v1/workspaces', headers: busy })
    expect(
      (await app.inject({ method: 'GET', url: '/v1/workspaces', headers: busy })).statusCode,
    ).toBe(429)
    expect(
      (await app.inject({ method: 'POST', url: '/v1/workspaces', payload: { ...config, id: 'w' } }))
        .statusCode,
    ).toBe(201)
    expect(
      (await app.inject({ method: 'POST', url: '/v1/workspaces', payload: config })).statusCode,
    ).toBe(503)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/workspaces/w/sessions',
          payload: { session_id: 's' },
        })
      ).statusCode,
    ).toBe(429)
    app.registry.draining = true
    expect(
      (await app.inject({ method: 'POST', url: '/v1/workspaces', payload: config })).statusCode,
    ).toBe(503)
    expect(reasons).toEqual(['rate_limit', 'max_workspaces', 'max_sessions', 'draining'])
    await app.close()
  })
})
