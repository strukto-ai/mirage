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
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { JaegerTransport } from './_client.ts'

const TRACE_A = 'a'.repeat(32)

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
  return new PathSpec({ virtual, directory: virtual, resourcePath: stripSlash(virtual) })
}

import { JaegerApiError } from './_client.ts'
import { read } from './read.ts'

const DEC = new TextDecoder()
const SERVICES = { '/api/services': { data: ['checkout'] } }

class ThrowingTransport implements JaegerTransport {
  constructor(private readonly status: number) {}

  request(path: string): Promise<unknown> {
    if (path === '/api/services') return Promise.resolve({ data: ['checkout'] })
    return Promise.reject(new JaegerApiError('boom', this.status))
  }
}

describe('jaeger read', () => {
  it('renders a trace document', async () => {
    const doc = {
      traceID: TRACE_A,
      spans: [{ operationName: 'POST /checkout', processID: 'p1' }],
      processes: { p1: { serviceName: 'checkout' } },
    }
    const transport = new RecordingTransport({
      ...SERVICES,
      [`/api/traces/${TRACE_A}`]: { data: [doc] },
    })
    const bytes = await read(
      accessor(transport),
      spec(`/services/checkout/traces/${TRACE_A}.json`),
      new RAMIndexCacheStore(),
    )
    expect(JSON.parse(DEC.decode(bytes))).toEqual(doc)
  })

  it('refuses a trace addressed through a service that did not emit it', async () => {
    // stat and ls report this path absent, so cat must agree; reading by id
    // would otherwise serve any trace through any service directory.
    const doc = {
      traceID: TRACE_A,
      spans: [{ operationName: 'POST /checkout', processID: 'p1' }],
      processes: { p1: { serviceName: 'checkout' } },
    }
    const transport = new RecordingTransport({
      '/api/services': { data: ['checkout', 'search'] },
      [`/api/traces/${TRACE_A}`]: { data: [doc] },
    })
    await expect(
      read(
        accessor(transport),
        spec(`/services/search/traces/${TRACE_A}.json`),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a trace under an unknown service', async () => {
    const transport = new RecordingTransport({
      ...SERVICES,
      [`/api/traces/${TRACE_A}`]: { data: [{ traceID: TRACE_A }] },
    })
    await expect(
      read(
        accessor(transport),
        spec(`/services/nope/traces/${TRACE_A}.json`),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('renders the operations list', async () => {
    const ops = [{ name: 'POST /checkout', spanKind: 'server' }]
    const transport = new RecordingTransport({ ...SERVICES, '/api/operations': { data: ops } })
    const bytes = await read(
      accessor(transport),
      spec('/services/checkout/operations.json'),
      new RAMIndexCacheStore(),
    )
    expect(JSON.parse(DEC.decode(bytes))).toEqual(ops)
  })

  it('treats a malformed trace id as ENOENT without calling the api', async () => {
    const transport = new RecordingTransport(SERVICES)
    await expect(
      read(
        accessor(transport),
        spec('/services/checkout/traces/zzz.json'),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(transport.calls.some((c) => c.path.startsWith('/api/traces/'))).toBe(false)
  })

  it('maps a missing trace to ENOENT', async () => {
    await expect(
      read(
        accessor(new ThrowingTransport(404)),
        spec(`/services/checkout/traces/${TRACE_A}.json`),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lets a server error propagate', async () => {
    // A server fault must not read as "this trace does not exist".
    await expect(
      read(
        accessor(new ThrowingTransport(500)),
        spec(`/services/checkout/traces/${TRACE_A}.json`),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toBeInstanceOf(JaegerApiError)
  })

  it('raises ENOENT for an unknown service and for a directory', async () => {
    const t = new RecordingTransport(SERVICES)
    await expect(
      read(accessor(t), spec('/services/nope/operations.json'), new RAMIndexCacheStore()),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      read(accessor(t), spec('/services'), new RAMIndexCacheStore()),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
