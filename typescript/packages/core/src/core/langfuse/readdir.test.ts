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
import type { Evicted, IndexEntry, SetDirOptions } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { vfsOver } from '../../test-utils.ts'
import { LangfuseVFS } from '../../vfs/langfuse/langfuse.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { LangfuseTransport } from './client.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'
import { jsonlBytes } from '../render/json.ts'

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

class WindowSpy extends RAMIndexCacheStore {
  readonly windows = new Map<string, boolean>()

  override setDir(
    vfsPath: string,
    entries: readonly [string, IndexEntry][],
    expiredAt?: Date | null,
    options: SetDirOptions = {},
  ): Promise<Evicted[]> {
    this.windows.set(vfsPath, options.window === true)
    return super.setDir(vfsPath, entries, expiredAt, options)
  }
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: stripSlash(virtual) })
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

describe('langfuse readdir dataset sizes', () => {
  it('sizes items.jsonl from one dataset-items call per dataset entered', async () => {
    const items = [
      { id: 'i-1', input: 'a' },
      { id: 'i-2', input: 'b' },
    ]
    const transport = new RecordingTransport({ '/api/public/dataset-items': { data: items } })
    const idx = new RAMIndexCacheStore()
    const entries = await readdir(accessor(transport), spec('/datasets/qa-eval'), idx)
    await readdir(accessor(transport), spec('/datasets/qa-eval'), idx)

    expect(entries).toEqual(['/datasets/qa-eval/items.jsonl', '/datasets/qa-eval/runs'])
    const lookup = await idx.get('/datasets/qa-eval/items.jsonl')
    expect(lookup.entry?.size).toBe(jsonlBytes(items).byteLength)
    expect(transport.calls.filter((c) => c.path === '/api/public/dataset-items')).toHaveLength(1)
  })

  it('stores the rendered run size on each run listing entry', async () => {
    const runs = [{ name: 'run-a', metadata: { k: 'v' } }, { name: 'run-b' }]
    const transport = new RecordingTransport({
      '/api/public/datasets/qa-eval/runs': { data: runs },
    })
    const idx = new RAMIndexCacheStore()
    await readdir(accessor(transport), spec('/datasets/qa-eval/runs'), idx)

    const lookup = await idx.get('/datasets/qa-eval/runs/run-a.jsonl')
    expect(lookup.entry?.size).toBe(jsonlBytes([runs[0] as Record<string, unknown>]).byteLength)
  })
})

// Mirrors python's test_a_bounded_trace_listing_is_not_cached_as_the_directory
// and test_a_trace_listing_short_of_the_limit_is_the_directory.
describe('langfuse bounded trace listing', () => {
  const TRACES = { '/api/public/traces': { data: [{ id: 't1' }, { id: 't2' }] } }
  it('fetches a full page once through the workspace index view', async () => {
    const transport = new RecordingTransport(TRACES)
    const vfs = vfsOver(LangfuseVFS, accessor(transport, { defaultTraceLimit: 2 }), {
      name: 'langfuse',
    })
    const ws = new Workspace({ '/nested/lf/': vfs }, { shellParser: await getTestParser() })
    try {
      const result = await ws.shell('ls -l /nested/lf/traces')
      expect(result.exitCode).toBe(0)
      expect(result.stdoutText).toContain('t1.json')
      expect(result.stdoutText).toContain('t2.json')
      expect(transport.calls).toHaveLength(1)
    } finally {
      await ws.close()
    }
  })
  const cases: [string, LangfuseAccessorConfig][] = [
    ['full page', { defaultTraceLimit: 2 }],
    ['time window', { defaultFromTimestamp: '2026-01-01T00:00:00Z' }],
  ]
  for (const [label, config] of cases) {
    it(`serves child stats without refetching a partial page (${label})`, async () => {
      const index = new RAMIndexCacheStore()
      const transport = new RecordingTransport(TRACES)
      const acc = accessor(transport, config)
      const paths = await readdir(acc, spec('/traces'), index)
      for (const path of paths) await stat(acc, spec(path), index)
      expect(transport.calls).toHaveLength(1)
      await readdir(acc, spec('/traces'), index)
      expect(transport.calls).toHaveLength(2)
    })

    it(`is not cached as the directory (${label})`, async () => {
      const index = new RAMIndexCacheStore()
      const out = await readdir(
        accessor(new RecordingTransport(TRACES), config),
        spec('/traces'),
        index,
      )
      expect(out).toEqual(['/traces/t1.json', '/traces/t2.json'])
      expect((await index.listDir('/traces')).entries).toBeUndefined()
      expect((await index.get('/traces/t1.json')).entry?.id).toBe('t1')
    })
  }

  it('short of the limit is the directory', async () => {
    const index = new RAMIndexCacheStore()
    await readdir(
      accessor(new RecordingTransport(TRACES), { defaultTraceLimit: 3 }),
      spec('/traces'),
      index,
    )
    expect((await index.listDir('/traces')).entries).toHaveLength(2)
  })
})

describe('langfuse single-page listings', () => {
  it.each([
    ['/sessions', '/api/public/sessions', [{ id: 'session-1' }]],
    ['/prompts', '/api/public/v2/prompts', [{ name: 'summarize', versions: [1] }]],
    ['/datasets', '/api/public/v2/datasets', [{ name: 'qa-eval' }]],
    ['/datasets/qa-eval/runs', '/api/public/datasets/qa-eval/runs', [{ name: 'run-a' }]],
  ])('writes %s as a window', async (path, endpoint, rows) => {
    // Each of these is one page of the newest entries: an older one that
    // drops off the page has not been deleted.
    const index = new WindowSpy()
    const out = await readdir(
      accessor(new RecordingTransport({ [endpoint]: { data: rows } })),
      spec(path),
      index,
    )
    expect(out).toHaveLength(1)
    expect(index.windows.get(path)).toBe(true)
  })
})
