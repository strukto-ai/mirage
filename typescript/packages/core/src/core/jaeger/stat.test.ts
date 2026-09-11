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
  return new PathSpec({ virtual, directory: virtual, resourcePath: stripSlash(virtual) })
}

import { ContentType, FileType } from '../../types.ts'
import { stat } from './stat.ts'

const SERVICES = { '/api/services': { data: ['checkout'] } }
const LISTED = { ...SERVICES, '/api/traces': { data: [{ traceID: TRACE_A }] } }

describe('jaeger stat', () => {
  it('stats the mount root', async () => {
    const s = await stat(accessor(new RecordingTransport({})), spec('/'), new RAMIndexCacheStore())
    expect(s.type).toBe(FileType.DIRECTORY)
  })

  it('stats the services directory without an api call', async () => {
    const transport = new RecordingTransport({})
    const s = await stat(accessor(transport), spec('/services'), new RAMIndexCacheStore())
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(transport.calls).toHaveLength(0)
  })

  it('stats a known service', async () => {
    const s = await stat(
      accessor(new RecordingTransport(SERVICES)),
      spec('/services/checkout'),
      new RAMIndexCacheStore(),
    )
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.extra.service).toBe('checkout')
  })

  it('raises ENOENT for an unknown service', async () => {
    await expect(
      stat(
        accessor(new RecordingTransport(SERVICES)),
        spec('/services/nope'),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stats the operations file', async () => {
    const s = await stat(
      accessor(new RecordingTransport(SERVICES)),
      spec('/services/checkout/operations.json'),
      new RAMIndexCacheStore(),
    )
    expect(s.content).toBe(ContentType.JSON)
  })

  it('stats a listed trace', async () => {
    const s = await stat(
      accessor(new RecordingTransport(LISTED)),
      spec(`/services/checkout/traces/${TRACE_A}.json`),
      new RAMIndexCacheStore(),
    )
    expect(s.content).toBe(ContentType.JSON)
    expect(s.extra.trace_id).toBe(TRACE_A)
  })

  it('raises ENOENT for a well-formed id that is not listed', async () => {
    // A well-formed id is not evidence the trace exists.
    await expect(
      stat(
        accessor(new RecordingTransport(LISTED)),
        spec(`/services/checkout/traces/${TRACE_B}.json`),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('raises ENOENT for a malformed id and a dotfile', async () => {
    const t = new RecordingTransport(LISTED)
    await expect(
      stat(accessor(t), spec('/services/checkout/traces/zzz.json'), new RAMIndexCacheStore()),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      stat(accessor(t), spec('/services/.hidden'), new RAMIndexCacheStore()),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
