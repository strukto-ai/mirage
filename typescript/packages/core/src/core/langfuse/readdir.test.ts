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
import { LangfuseVFS } from '../../vfs/langfuse/langfuse.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import type { DirListing } from '../../types.ts'
import { PathSpec, type FileStat } from '../../types.ts'
import { rowsOf } from '../hierarchy/probe.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { LangfuseTransport } from './client.ts'
import { readdir } from './readdir.ts'
import { jsonlBytes } from '../render/json.ts'

function names(listed: readonly FileStat[] | DirListing): string[] {
  return rowsOf(listed).map((row) => row.name)
}

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

// A LangfuseVFS over `over`, so a mount lists through the test's transport.
function mountedVfs(over: LangfuseAccessor): LangfuseVFS {
  return Object.assign(new LangfuseVFS({ publicKey: 'pk', secretKey: 'sk' }), { accessor: over })
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
    const entries = await readdir(accessor(transport), spec('/prompts/greeting'))
    expect(names(entries)).toEqual(['1.json', '2.json'])
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
    const entries = await readdir(accessor(transport), spec('/prompts'))
    expect(names(entries)).toEqual(['greeting', 'qa-template'])
  })
})

describe('langfuse readdir trace window', () => {
  it('applies no fromTimestamp when the config leaves it unset', async () => {
    // A rolling default window hid traces that read() happily serves, so an
    // unset config must not narrow the listing.
    const transport = new RecordingTransport({
      '/api/public/traces': { data: [{ id: 'trace-old' }] },
    })
    const entries = await readdir(accessor(transport), spec('/traces'))
    expect(names(entries)).toEqual(['trace-old.json'])
    expect(transport.calls[0]?.query).not.toHaveProperty('fromTimestamp')
  })

  it('passes an explicit fromTimestamp through', async () => {
    const transport = new RecordingTransport({
      '/api/public/traces': { data: [{ id: 'trace-new' }] },
    })
    await readdir(
      accessor(transport, { defaultFromTimestamp: '2026-01-01T00:00:00Z' }),
      spec('/traces'),
    )
    expect(transport.calls[0]?.query?.fromTimestamp).toBe('2026-01-01T00:00:00Z')
  })

  it('defaults the trace limit to python default_trace_limit', async () => {
    const transport = new RecordingTransport({
      '/api/public/traces': { data: [] },
    })
    await readdir(accessor(transport), spec('/traces'))
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
    const entries = rowsOf(await readdir(accessor(transport), spec('/datasets/qa-eval')))
    expect(entries.map((row) => row.name)).toEqual(['items.jsonl', 'runs'])
    expect(entries[0]?.size).toBe(jsonlBytes(items).byteLength)
  })

  it('stores the rendered run size on each run listing entry', async () => {
    const runs = [{ name: 'run-a', metadata: { k: 'v' } }, { name: 'run-b' }]
    const transport = new RecordingTransport({
      '/api/public/datasets/qa-eval/runs': { data: runs },
    })
    const listed = rowsOf(await readdir(accessor(transport), spec('/datasets/qa-eval/runs')))
    expect(listed[0]?.name).toBe('run-a.jsonl')
    expect(listed[0]?.size).toBe(jsonlBytes([runs[0] as Record<string, unknown>]).byteLength)
  })
})

// Mirrors python's test_a_bounded_trace_listing_is_not_cached_as_the_directory
// and test_a_trace_listing_short_of_the_limit_is_the_directory.
describe('langfuse bounded trace listing', () => {
  const TRACES = { '/api/public/traces': { data: [{ id: 't1' }, { id: 't2' }] } }
  it('fetches a full page once through the workspace index view', async () => {
    const transport = new RecordingTransport(TRACES)
    const vfs = mountedVfs(accessor(transport, { defaultTraceLimit: 2 }))
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
      const transport = new RecordingTransport(TRACES)
      const ws = new Workspace({ '/lf/': mountedVfs(accessor(transport, config)) })
      try {
        const paths = (await ws.dispatch('readdir', '/lf/traces')) as string[]
        for (const path of paths) await ws.dispatch('stat', path)
        expect(transport.calls).toHaveLength(1)
        await ws.dispatch('readdir', '/lf/traces')
        expect(transport.calls).toHaveLength(2)
      } finally {
        await ws.close()
      }
    })

    it(`is not cached as the directory (${label})`, async () => {
      const out = await readdir(accessor(new RecordingTransport(TRACES), config), spec('/traces'))
      expect(names(out)).toEqual(['t1.json', 't2.json'])
      expect((out as DirListing).partial).toBe(true)
    })
  }

  it('short of the limit is the directory', async () => {
    const out = await readdir(
      accessor(new RecordingTransport(TRACES), { defaultTraceLimit: 3 }),
      spec('/traces'),
    )
    expect((out as DirListing).partial).toBe(false)
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
    const out = await readdir(
      accessor(new RecordingTransport({ [endpoint]: { data: rows } })),
      spec(path),
    )
    expect(rowsOf(out)).toHaveLength(1)
    expect((out as DirListing).window).toBe(true)
  })
})
