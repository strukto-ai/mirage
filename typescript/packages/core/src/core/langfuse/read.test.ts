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
import { PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { LangfuseApiError, type LangfuseTransport } from './_client.ts'
import { read } from './read.ts'

const DEC = new TextDecoder()

class RecordingTransport implements LangfuseTransport {
  readonly paths: string[] = []

  constructor(private readonly bodies: Record<string, unknown>) {}

  request(path: string): Promise<unknown> {
    this.paths.push(path)
    const body = this.bodies[path]
    if (body === undefined) return Promise.resolve({ data: [] })
    return Promise.resolve(body)
  }
}

class ThrowingTransport implements LangfuseTransport {
  constructor(private readonly status: number) {}

  request(): Promise<unknown> {
    return Promise.reject(new LangfuseApiError('boom', [], this.status))
  }
}

function accessor(transport: LangfuseTransport) {
  return new LangfuseAccessor(transport)
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: stripSlash(virtual) })
}

describe('langfuse read dataset run', () => {
  it('renders a .jsonl run as one line, not an indented document', async () => {
    const transport = new RecordingTransport({
      '/api/public/datasets/eval-basic/runs': {
        data: [{ name: 'run-alpha', datasetName: 'eval-basic' }],
      },
    })
    const bytes = await read(
      accessor(transport),
      spec('/datasets/eval-basic/runs/run-alpha.jsonl'),
      new RAMIndexCacheStore(),
    )
    const text = DEC.decode(bytes)
    expect(text.trimEnd().split('\n')).toHaveLength(1)
    expect(JSON.parse(text.trimEnd())).toMatchObject({ name: 'run-alpha' })
  })

  it('requests dataset runs outside the v2 namespace', async () => {
    // /api/public/v2/datasets/{name}/runs is a hard 404 on a real server.
    const transport = new RecordingTransport({
      '/api/public/datasets/eval-basic/runs': { data: [{ name: 'run-alpha' }] },
    })
    await read(
      accessor(transport),
      spec('/datasets/eval-basic/runs/run-alpha.jsonl'),
      new RAMIndexCacheStore(),
    )
    expect(transport.paths).toEqual(['/api/public/datasets/eval-basic/runs'])
  })

  it('raises ENOENT when the named run is absent', async () => {
    const transport = new RecordingTransport({
      '/api/public/datasets/eval-basic/runs': { data: [{ name: 'other' }] },
    })
    await expect(
      read(
        accessor(transport),
        spec('/datasets/eval-basic/runs/run-alpha.jsonl'),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('langfuse read error mapping', () => {
  it('translates a 404 into ENOENT', async () => {
    await expect(
      read(
        accessor(new ThrowingTransport(404)),
        spec('/traces/absent.json'),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lets a 500 propagate instead of disguising it as a missing file', async () => {
    // A server fault must not read as "this trace does not exist".
    await expect(
      read(
        accessor(new ThrowingTransport(500)),
        spec('/traces/whatever.json'),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toBeInstanceOf(LangfuseApiError)
  })
})

describe('langfuse read dataset items', () => {
  it('renders items as line-delimited JSON', async () => {
    const transport = new RecordingTransport({
      '/api/public/dataset-items': {
        data: [{ id: 'item-one' }, { id: 'item-two' }],
      },
    })
    const bytes = await read(
      accessor(transport),
      spec('/datasets/eval-basic/items.jsonl'),
      new RAMIndexCacheStore(),
    )
    const lines = DEC.decode(bytes).trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => (JSON.parse(l) as { id: string }).id)).toEqual([
      'item-one',
      'item-two',
    ])
  })

  it('renders an empty dataset as an empty file', async () => {
    const transport = new RecordingTransport({ '/api/public/dataset-items': { data: [] } })
    const bytes = await read(
      accessor(transport),
      spec('/datasets/eval-empty/items.jsonl'),
      new RAMIndexCacheStore(),
    )
    expect(DEC.decode(bytes)).toBe('')
  })
})
