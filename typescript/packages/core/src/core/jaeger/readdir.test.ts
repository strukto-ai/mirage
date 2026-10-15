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
import { JaegerAccessor, type JaegerAccessorConfig } from '../../accessor/jaeger.ts'
import { DirListing, FileType, PathSpec, type FileStat } from '../../types.ts'
import { rowsOf } from '../hierarchy/probe.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { JaegerTransport } from './client.ts'

const TRACE_A = 'a'.repeat(32)
const TRACE_B = 'b'.repeat(32)

interface Call {
  path: string
  query?: Record<string, string | number | undefined>
}

class RecordingTransport implements JaegerTransport {
  readonly calls: Call[] = []

  constructor(private readonly bodies: Record<string, unknown>) {}

  request(path: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    this.calls.push(query === undefined ? { path } : { path, query })
    const body = this.bodies[path]
    if (body === undefined) return Promise.resolve({ data: [] })
    return Promise.resolve(body)
  }
}

function accessor(transport: JaegerTransport, config: JaegerAccessorConfig = {}) {
  return new JaegerAccessor(transport, config)
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: stripSlash(virtual) })
}

import { readdir } from './readdir.ts'

function names(listed: readonly FileStat[] | DirListing): string[] {
  return rowsOf(listed).map((row) => row.name)
}
import { jsonBytes } from '../render/json.ts'

const SERVICES = { '/api/services': { data: ['checkout', 'search'] } }

describe('jaeger readdir', () => {
  it('lists the top level', async () => {
    const out = await readdir(accessor(new RecordingTransport({})), spec('/'))
    expect(names(out)).toEqual(['services'])
  })

  it('lists services', async () => {
    const out = await readdir(accessor(new RecordingTransport(SERVICES)), spec('/services'))
    expect(names(out)).toEqual(['checkout', 'search'])
  })

  it("lists a service's children", async () => {
    const out = await readdir(
      accessor(new RecordingTransport(SERVICES)),
      spec('/services/checkout'),
    )
    expect(names(out)).toEqual(['operations.json', 'traces'])
  })

  it('stores the rendered operations size on the service listing', async () => {
    const operations = [
      { name: 'POST /checkout', spanKind: 'server' },
      { name: 'charge-card', spanKind: 'server' },
    ]
    const transport = new RecordingTransport({
      ...SERVICES,
      '/api/operations': { data: operations },
    })
    const out = rowsOf(await readdir(accessor(transport), spec('/services/checkout')))
    expect(out[0]?.size).toBe(jsonBytes(operations).byteLength)
    expect(out[1]?.type).toBe(FileType.DIRECTORY)
  })

  it('raises ENOENT for an unknown service', async () => {
    // The operations endpoint answers 200 with an empty list for a service
    // that was never seen, so existence must come from the service list.
    await expect(
      readdir(accessor(new RecordingTransport(SERVICES)), spec('/services/nope')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lists traces for a service', async () => {
    const transport = new RecordingTransport({
      ...SERVICES,
      '/api/traces': { data: [{ traceID: TRACE_A }, { traceID: TRACE_B }] },
    })
    const out = await readdir(accessor(transport), spec('/services/checkout/traces'))
    expect(names(out)).toEqual([`${TRACE_A}.json`, `${TRACE_B}.json`])
  })

  it('stores the rendered trace size on each listing entry', async () => {
    const trace = {
      traceID: TRACE_A,
      spans: [{ spanID: 's1', operationName: 'GET /pay' }],
      processes: { p1: { serviceName: 'checkout' } },
    }
    const transport = new RecordingTransport({ ...SERVICES, '/api/traces': { data: [trace] } })
    const out = rowsOf(await readdir(accessor(transport), spec('/services/checkout/traces')))
    expect(out[0]?.size).toBe(jsonBytes(trace).byteLength)
    expect(out[0]?.extra).toEqual({ trace_id: TRACE_A })
  })

  it('skips malformed trace ids', async () => {
    const transport = new RecordingTransport({
      ...SERVICES,
      '/api/traces': { data: [{ traceID: TRACE_A }, { traceID: 'not-an-id' }, {}] },
    })
    const out = await readdir(accessor(transport), spec('/services/checkout/traces'))
    expect(names(out)).toEqual([`${TRACE_A}.json`])
  })

  it('threads the configured window and limit', async () => {
    const transport = new RecordingTransport({ ...SERVICES, '/api/traces': { data: [] } })
    await readdir(
      accessor(transport, { defaultTraceLimit: 5, defaultFromTimestamp: '2026-01-01T00:00:00Z' }),
      spec('/services/checkout/traces'),
    )
    const call = transport.calls.find((c) => c.path === '/api/traces')
    expect(call?.query?.limit).toBe(5)
    expect(call?.query?.start).toBe(1767225600000000)
  })

  it('raises ENOENT for a dotfile and an unknown path', async () => {
    const t = new RecordingTransport(SERVICES)
    await expect(readdir(accessor(t), spec('/services/.hidden'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(readdir(accessor(t), spec('/traces'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('jaeger trace window', () => {
  it('writes a trace listing as a window', async () => {
    // The listing is the newest defaultTraceLimit traces; an older trace
    // that falls off it is still in Jaeger.
    const transport = new RecordingTransport({
      ...SERVICES,
      '/api/traces': { data: [{ traceID: TRACE_A }] },
    })
    const out = await readdir(accessor(transport), spec('/services/checkout/traces'))
    expect(out).toBeInstanceOf(DirListing)
    expect((out as DirListing).window).toBe(true)
  })
})
