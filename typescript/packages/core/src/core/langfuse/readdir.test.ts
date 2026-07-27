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
import { LangfuseAccessor, type LangfuseAccessorConfig } from '../../accessor/langfuse.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { LangfuseTransport } from './_client.ts'
import { readdir } from './readdir.ts'

interface Call {
  path: string
  query?: Record<string, string | number | undefined>
}

class RecordingTransport implements LangfuseTransport {
  readonly calls: Call[] = []

  constructor(private readonly bodies: Record<string, unknown>) {}

  request(path: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    this.calls.push(query === undefined ? { path } : { path, query })
    const body = this.bodies[path]
    if (body === undefined) return Promise.resolve({ data: [] })
    return Promise.resolve(body)
  }
}

function accessor(transport: LangfuseTransport, config: LangfuseAccessorConfig = {}) {
  return new LangfuseAccessor(transport, config)
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: stripSlash(virtual) })
}

describe('langfuse readdir prompt versions', () => {
  it('lists one file per version from the versions array', async () => {
    // The list endpoint returns PromptMeta rows carrying every version in a
    // `versions` array; reading a scalar `version` yielded a single 0.json.
    const transport = new RecordingTransport({
      '/api/public/v2/prompts': {
        data: [
          { name: 'greeting', versions: [1, 2], type: 'text' },
          { name: 'qa-template', versions: [1], type: 'chat' },
        ],
      },
    })
    const entries = await readdir(
      accessor(transport),
      spec('/prompts/greeting'),
      new RAMIndexCacheStore(),
    )
    expect(entries).toEqual(['/prompts/greeting/1.json', '/prompts/greeting/2.json'])
  })

  it('lists prompt names once regardless of version count', async () => {
    const transport = new RecordingTransport({
      '/api/public/v2/prompts': {
        data: [
          { name: 'greeting', versions: [1, 2, 3], type: 'text' },
          { name: 'qa-template', versions: [1], type: 'chat' },
        ],
      },
    })
    const entries = await readdir(accessor(transport), spec('/prompts'), new RAMIndexCacheStore())
    expect(entries).toEqual(['/prompts/greeting', '/prompts/qa-template'])
  })
})

describe('langfuse readdir trace window', () => {
  it('applies no fromTimestamp when the config leaves it unset', async () => {
    // A rolling default window hid traces that read() happily serves, so an
    // unset config must not narrow the listing.
    const transport = new RecordingTransport({
      '/api/public/traces': { data: [{ id: 'trace-old' }] },
    })
    const entries = await readdir(accessor(transport), spec('/traces'), new RAMIndexCacheStore())
    expect(entries).toEqual(['/traces/trace-old.json'])
    expect(transport.calls[0]?.query).not.toHaveProperty('fromTimestamp')
  })

  it('passes an explicit fromTimestamp through', async () => {
    const transport = new RecordingTransport({
      '/api/public/traces': { data: [{ id: 'trace-new' }] },
    })
    await readdir(
      accessor(transport, { defaultFromTimestamp: '2026-01-01T00:00:00Z' }),
      spec('/traces'),
      new RAMIndexCacheStore(),
    )
    expect(transport.calls[0]?.query?.fromTimestamp).toBe('2026-01-01T00:00:00Z')
  })

  it('defaults the trace limit to python default_trace_limit', async () => {
    const transport = new RecordingTransport({
      '/api/public/traces': { data: [] },
    })
    await readdir(accessor(transport), spec('/traces'), new RAMIndexCacheStore())
    expect(transport.calls[0]?.query?.limit).toBe(100)
  })
})
