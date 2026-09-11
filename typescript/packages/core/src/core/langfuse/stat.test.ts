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
import { LangfuseAccessor } from '../../accessor/langfuse.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { ContentType, FileType, PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { LangfuseTransport } from './client.ts'
import { stat } from './stat.ts'

class StaticTransport implements LangfuseTransport {
  constructor(private readonly bodies: Record<string, unknown>) {}

  request(path: string): Promise<unknown> {
    const body = this.bodies[path]
    if (body === undefined) return Promise.resolve({ data: [] })
    return Promise.resolve(body)
  }
}

function accessor(transport: LangfuseTransport) {
  return new LangfuseAccessor(transport)
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: stripSlash(virtual) })
}

const TRACES = { '/api/public/traces': { data: [{ id: 'present' }] } }
const PROMPTS = {
  '/api/public/v2/prompts': { data: [{ name: 'greeting', versions: [1], type: 'text' }] },
}

describe('langfuse stat existence', () => {
  it('stats a trace that appears in its parent listing', async () => {
    const s = await stat(
      accessor(new StaticTransport(TRACES)),
      spec('/traces/present.json'),
      new RAMIndexCacheStore(),
    )
    expect(s.content).toBe(ContentType.JSON)
    expect(s.name).toBe('present.json')
  })

  it('raises ENOENT for a trace absent from the listing', async () => {
    // A recognizable path shape is not evidence the trace exists.
    await expect(
      stat(
        accessor(new StaticTransport(TRACES)),
        spec('/traces/absent.json'),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('raises ENOENT for a prompt version that was never published', async () => {
    await expect(
      stat(
        accessor(new StaticTransport(PROMPTS)),
        spec('/prompts/greeting/9.json'),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stats a published prompt version', async () => {
    const s = await stat(
      accessor(new StaticTransport(PROMPTS)),
      spec('/prompts/greeting/1.json'),
      new RAMIndexCacheStore(),
    )
    expect(s.content).toBe(ContentType.JSON)
  })

  it('stats the mount root without consulting the api', async () => {
    const s = await stat(accessor(new StaticTransport({})), spec('/'), new RAMIndexCacheStore())
    expect(s.type).toBe(FileType.DIRECTORY)
  })

  it('stats a top-level directory without consulting the api', async () => {
    const s = await stat(
      accessor(new StaticTransport({})),
      spec('/traces'),
      new RAMIndexCacheStore(),
    )
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.name).toBe('traces')
  })
})
