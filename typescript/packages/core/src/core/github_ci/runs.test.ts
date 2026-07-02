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
import { GitHubCIAccessor } from '../../accessor/github_ci.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { GITHUB_CI_FIND } from '../../commands/builtin/github_ci/find.ts'
import type { CommandOpts } from '../../commands/config.ts'
import { PathSpec, ResourceName } from '../../types.ts'
import { HttpCITransport, type CITransport } from './_client.ts'
import { readdir as ciReaddir } from './readdir.ts'
import { listRuns } from './runs.ts'

class FakeCITransport implements CITransport {
  calls: { path: string; params?: Record<string, string>; maxResults?: number }[] = []
  total: number

  constructor(total: number) {
    this.total = total
  }

  get(_path: string): Promise<unknown> {
    return Promise.resolve({})
  }

  getBytes(_path: string): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array())
  }

  async getPaginated(
    path: string,
    listKey: string,
    params?: Record<string, string>,
    maxResults?: number,
  ): Promise<unknown[]> {
    const entry: { path: string; params?: Record<string, string>; maxResults?: number } = { path }
    if (params !== undefined) entry.params = params
    if (maxResults !== undefined) entry.maxResults = maxResults
    this.calls.push(entry)
    const limit = maxResults !== undefined ? Math.min(this.total, maxResults) : this.total
    const items = Array.from({ length: limit }, (_, i) => ({
      id: i,
      name: `${listKey}-${String(i)}`,
    }))
    return Promise.resolve(items)
  }
}

describe('GitHubCIAccessor', () => {
  it('defaults maxRuns to 300', () => {
    const accessor = new GitHubCIAccessor({
      transport: new FakeCITransport(0),
      owner: 'o',
      repo: 'r',
    })
    expect(accessor.maxRuns).toBe(300)
  })

  it('respects explicit maxRuns', () => {
    const accessor = new GitHubCIAccessor({
      transport: new FakeCITransport(0),
      owner: 'o',
      repo: 'r',
      maxRuns: 42,
    })
    expect(accessor.maxRuns).toBe(42)
  })
})

describe('HttpCITransport.getPaginated', () => {
  function mockFetch(total: number): { calls: URL[]; restore: () => void } {
    const calls: URL[] = []
    const original = globalThis.fetch
    globalThis.fetch = ((input: string | URL | Request) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(raw)
      calls.push(url)
      const page = Number(url.searchParams.get('page') ?? '1')
      const perPage = Number(url.searchParams.get('per_page') ?? '100')
      const start = (page - 1) * perPage
      const end = Math.min(start + perPage, total)
      const items = Array.from({ length: Math.max(0, end - start) }, (_, i) => ({
        id: start + i,
      }))
      return Promise.resolve(
        new Response(JSON.stringify({ workflow_runs: items }), { status: 200 }),
      )
    }) as typeof globalThis.fetch
    return { calls, restore: () => (globalThis.fetch = original) }
  }

  it('truncates results and stops paging early when maxResults set', async () => {
    const { calls, restore } = mockFetch(1000)
    try {
      const transport = new HttpCITransport({ token: 't' })
      const out = await transport.getPaginated('/r', 'workflow_runs', undefined, 300)
      expect(out.length).toBe(300)
      expect(calls.length).toBe(3)
    } finally {
      restore()
    }
  })

  it('returns all items when no maxResults', async () => {
    const { calls, restore } = mockFetch(50)
    try {
      const transport = new HttpCITransport({ token: 't' })
      const out = await transport.getPaginated('/r', 'workflow_runs')
      expect(out.length).toBe(50)
      expect(calls.length).toBe(1)
    } finally {
      restore()
    }
  })
})

describe('listRuns', () => {
  it('passes maxRuns through to transport', async () => {
    const transport = new FakeCITransport(1000)
    const out = await listRuns(transport, 'o', 'r', 30, 150)
    expect(out.length).toBe(150)
    expect(transport.calls.length).toBe(1)
    expect(transport.calls[0]?.maxResults).toBe(150)
  })

  it('defaults maxRuns to 300 when omitted', async () => {
    const transport = new FakeCITransport(1000)
    const out = await listRuns(transport, 'o', 'r')
    expect(out.length).toBe(300)
    expect(transport.calls[0]?.maxResults).toBe(300)
  })
})

describe('readdir(/runs) cap', () => {
  it('limits the listed run directories to maxRuns', async () => {
    const transport = new FakeCITransport(1000)
    const accessor = new GitHubCIAccessor({
      transport,
      owner: 'o',
      repo: 'r',
      maxRuns: 7,
    })
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({
      virtual: '/runs',
      directory: '/runs',
      resolved: false,
      resourcePath: 'runs',
    })
    const out = await ciReaddir(accessor, path, index)
    expect(out.length).toBe(7)
    expect(transport.calls[0]?.maxResults).toBe(7)
  })
})

describe('find on /runs', () => {
  it('produces at most maxRuns run directories', async () => {
    const transport = new FakeCITransport(1000)
    const accessor = new GitHubCIAccessor({
      transport,
      owner: 'o',
      repo: 'r',
      maxRuns: 5,
    })
    const index = new RAMIndexCacheStore()
    const opts: CommandOpts = {
      stdin: null,
      flags: { maxdepth: '1' },
      filetypeFns: null,
      mountPrefix: '',
      cwd: '/',
      resource: { kind: ResourceName.GITHUB_CI } as unknown as CommandOpts['resource'],
      index,
    }
    const findCmd = GITHUB_CI_FIND[0]
    if (findCmd === undefined) throw new Error('GITHUB_CI_FIND missing')
    const result = await findCmd.fn(
      accessor as unknown as Parameters<typeof findCmd.fn>[0],
      [
        new PathSpec({
          virtual: '/runs',
          directory: '/runs',
          resolved: false,
          resourcePath: 'runs',
        }),
      ],
      [],
      opts,
    )
    expect(result).not.toBeNull()
    const [bytes] = result as [Uint8Array, unknown]
    const lines = new TextDecoder().decode(bytes).split('\n')
    const runDirs = lines.filter((l) => /^\/runs\/[^/]+$/.test(l))
    expect(runDirs.length).toBe(5)
  })
})
