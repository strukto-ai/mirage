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
import { OpsRegistry } from '../../ops/registry.ts'
import { FileType, MountMode, PathSpec, ResourceName } from '../../types.ts'
import { Workspace } from '../../workspace/workspace.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import {
  HttpNowledgeMemTransport,
  normalizeNowledgeMemConfig,
} from '../../core/nowledge_mem/client.ts'
import { NowledgeMemResource } from './nowledge_mem.ts'

const DEC = new TextDecoder()

interface RequestRecord {
  url: URL
  headers: Headers
}

const originalFetch = globalThis.fetch
let requests: RequestRecord[] = []
const ROOT_NAMES = [
  'memories',
  'threads',
  'sources',
  'wiki',
  'working-memory',
  'feed',
  'artifacts',
  'skills',
]
const ROOT_ENTRIES = ROOT_NAMES.map((name) => ({
  name,
  path: `/${name}`,
  kind: 'directory' as const,
  type: 'directory',
}))
const ROOT_PATHS = ROOT_NAMES.map((name) => `/${name}`)
const ROOT_LS_OUTPUT = ROOT_NAMES.join('\n')

function mockFetch(handler: (url: URL) => unknown): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push({ url, headers: new Headers(init?.headers) })
    return new Response(JSON.stringify(handler(url)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
  requests = []
  vi.restoreAllMocks()
})

describe('NowledgeMemResource', () => {
  it('normalizes config without requiring the nmem CLI', () => {
    expect(
      normalizeNowledgeMemConfig({ api_url: 'https://mem.example/', api_key: 'secret' }),
    ).toEqual({
      apiUrl: 'https://mem.example/',
      apiKey: 'secret',
    })
  })

  it('mounts Nowledge Mem as an API-backed read-only resource', async () => {
    mockFetch((url) => {
      if (url.pathname === '/fs/ls') {
        return {
          entries: ROOT_ENTRIES,
        }
      }
      if (url.pathname === '/fs/cat') {
        return {
          path: '/memories/by-id/m1.memory.md',
          body: 'memory body',
          content_type: 'markdown',
        }
      }
      if (url.pathname === '/fs/stat') {
        return {
          path: '/memories',
          name: 'memories',
          kind: 'directory',
          type: 'directory',
        }
      }
      throw new Error(`unexpected endpoint ${url.pathname}`)
    })

    const resource = new NowledgeMemResource({
      apiUrl: 'https://mem.example/',
      apiKey: 'secret',
    })

    await expect(resource.readdir(PathSpec.fromStrPath('/mem', '/mem'))).resolves.toEqual(
      ROOT_PATHS,
    )
    await expect(
      resource.readFile(PathSpec.fromStrPath('/mem/memories/by-id/m1.memory.md', '/mem')),
    ).resolves.toEqual(new TextEncoder().encode('memory body'))

    const stat = await resource.stat(PathSpec.fromStrPath('/mem/memories', '/mem'))
    expect(stat.name).toBe('memories')
    expect(stat.type).toBe(FileType.DIRECTORY)
    expect(resource.kind).toBe(ResourceName.NOWLEDGE_MEM)

    expect(requests.map((r) => r.url.pathname)).toEqual(['/fs/ls', '/fs/cat', '/fs/stat'])
    expect(requests[0]?.url.searchParams.get('path')).toBe('/')
    expect(requests[1]?.url.searchParams.get('path')).toBe('/memories/by-id/m1.memory.md')
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer secret')
  })

  it('trims trailing slashes when building API URLs', async () => {
    mockFetch((url) => {
      expect(url.toString()).toBe('https://mem.example/fs/ls?path=%2F')
      return { entries: [] }
    })
    const transport = new HttpNowledgeMemTransport({ apiUrl: 'https://mem.example///' })
    await transport.request('/fs/ls', { path: '/' })
  })

  it('exposes ls, cat, grep, find, and recall commands over the API', async () => {
    mockFetch((url) => {
      if (url.pathname === '/fs/ls') {
        expect(url.searchParams.get('path')).toBe('/')
        return {
          entries: ROOT_ENTRIES,
        }
      }
      if (url.pathname === '/fs/cat') {
        const path = url.searchParams.get('path')
        if (path === '/threads/codex/release-planning/messages.jsonl') {
          expect(url.searchParams.get('line')).toBe('40')
          expect(url.searchParams.get('lines')).toBe('20')
          return {
            path,
            body: '{"role":"assistant","content":"JWT rotation evidence"}',
          }
        }
        expect(path).toBe('/memories/by-id/m1.memory.md')
        return {
          path: '/memories/by-id/m1.memory.md',
          body: 'JWT rotation decision',
        }
      }
      if (url.pathname === '/fs/grep') {
        expect(url.searchParams.get('path')).toBe('/memories')
        expect(url.searchParams.get('q')).toBe('JWT')
        expect(url.searchParams.get('limit')).toBe('5')
        return {
          matches: [{ path: '/memories/by-id/m1.memory.md', line: 7, match: 'JWT rotation' }],
        }
      }
      if (url.pathname === '/fs/find') {
        expect(url.searchParams.get('path')).toBe('/memories')
        expect(url.searchParams.get('label')).toBe('security')
        expect(url.searchParams.get('limit')).toBe('5')
        return { paths: ['/memories/by-id/m1.memory.md'] }
      }
      if (url.pathname === '/fs/recall') {
        expect(url.searchParams.get('path')).toBe('/memories')
        expect(url.searchParams.get('query')).toBe('jwt rotation')
        expect(url.searchParams.get('k')).toBe('3')
        return { paths: ['/memories/by-id/m1.memory.md'] }
      }
      throw new Error(`unexpected endpoint ${url.pathname}`)
    })

    const resource = new NowledgeMemResource({ apiUrl: 'https://mem.example', defaultLimit: 5 })
    const registry = new OpsRegistry()
    registry.registerResource(resource)
    const ws = new Workspace(
      { '/mem': resource },
      { mode: MountMode.EXEC, ops: registry, shellParser: await getTestParser() },
    )

    const ls = await ws.execute('ls /mem')
    expect(ls.exitCode).toBe(0)
    expect(DEC.decode(ls.stdout)).toBe(ROOT_LS_OUTPUT)

    const cat = await ws.execute('cat /mem/memories/by-id/m1.memory.md')
    expect(cat.exitCode).toBe(0)
    expect(DEC.decode(cat.stdout)).toBe('JWT rotation decision')

    const threadWindow = await ws.execute(
      'cat --line 40 --lines 20 /mem/threads/codex/release-planning/messages.jsonl',
    )
    expect(threadWindow.exitCode).toBe(0)
    expect(DEC.decode(threadWindow.stdout)).toBe(
      '{"role":"assistant","content":"JWT rotation evidence"}',
    )

    const grep = await ws.execute('grep -n JWT /mem/memories')
    expect(grep.exitCode).toBe(0)
    expect(DEC.decode(grep.stdout)).toBe('/memories/by-id/m1.memory.md:7:JWT rotation')

    const find = await ws.execute('find /mem/memories --label security')
    expect(find.exitCode).toBe(0)
    expect(DEC.decode(find.stdout)).toBe('/memories/by-id/m1.memory.md')

    const recall = await ws.execute('recall "jwt rotation" --in /mem/memories -k 3')
    expect(recall.exitCode).toBe(0)
    expect(DEC.decode(recall.stdout)).toBe('/memories/by-id/m1.memory.md')

    await ws.close()
  })
})
