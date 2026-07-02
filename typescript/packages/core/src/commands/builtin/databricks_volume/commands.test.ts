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

import { mountKey } from '../../../utils/key_prefix.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { Resource } from '../../../resource/base.ts'
import type { RegisteredCommand } from '../../config.ts'
import {
  jsonResponse,
  makeAccessor,
  notFoundResponse,
  routedFetch,
  TEST_ROOT,
  type FetchCall,
} from '../../../core/databricks_volume/_test_util.ts'
import { DATABRICKS_VOLUME_COMMANDS } from './index.ts'

const DEC = new TextDecoder()

afterEach(() => {
  vi.unstubAllGlobals()
})

function cmdOf(name: string): RegisteredCommand {
  const cmd = DATABRICKS_VOLUME_COMMANDS.find((c) => c.name === name)
  if (cmd === undefined) throw new Error(`${name} not registered`)
  return cmd
}

function pathOf(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual, mountKey(virtual, '/volume'))
}

async function run(
  name: string,
  paths: PathSpec[],
  texts: string[] = [],
  flags: Record<string, string | boolean | string[]> = {},
): Promise<{ stdout: string; exitCode: number; writes: string[] }> {
  const cmd = cmdOf(name)
  const result = await cmd.fn(makeAccessor(), paths, texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: null as unknown as Resource,
  })
  if (result === null) return { stdout: '', exitCode: 0, writes: [] }
  const [out, io] = result
  let stdout = ''
  if (out !== null) {
    const buf =
      out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
    stdout = DEC.decode(buf)
  }
  return { stdout, exitCode: io.exitCode, writes: Object.keys(io.writes) }
}

describe('databricks_volume commands registry', () => {
  it('registers the filesystem and bespoke commands', () => {
    const names = new Set(DATABRICKS_VOLUME_COMMANDS.map((c) => c.name))
    for (const name of [
      'awk',
      'cat',
      'cp',
      'cut',
      'diff',
      'find',
      'grep',
      'head',
      'jq',
      'ls',
      'mkdir',
      'mv',
      'nl',
      'rg',
      'rm',
      'sed',
      'sort',
      'stat',
      'tail',
      'touch',
      'tr',
      'tree',
      'uniq',
      'wc',
    ]) {
      expect(names.has(name)).toBe(true)
    }
  })
})

describe('cat', () => {
  it('streams file contents', async () => {
    const { fetch } = routedFetch((call: FetchCall) => {
      if (call.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'Content-Length': '5' } })
      }
      return new Response('hello', { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const { stdout } = await run('cat', [pathOf('/volume/a.txt')])
    expect(stdout).toBe('hello')
  })
})

describe('ls', () => {
  it('lists directory entries', async () => {
    const { fetch } = routedFetch((call: FetchCall) => {
      if (call.method === 'GET' && call.url.includes('/fs/directories/')) {
        return jsonResponse({
          contents: [
            { path: `${TEST_ROOT}/b.txt`, file_size: 2 },
            { path: `${TEST_ROOT}/a`, is_directory: true },
          ],
        })
      }
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const { stdout } = await run('ls', [
      new PathSpec({
        virtual: '/volume/',
        directory: '/volume/',
        resourcePath: mountKey('/volume/', '/volume'),
        resolved: false,
      }),
    ])
    expect(stdout.split('\n').filter(Boolean)).toEqual(['a', 'b.txt'])
  })
})

describe('grep', () => {
  it('matches lines in a file', async () => {
    const { fetch } = routedFetch((call: FetchCall) => {
      if (call.method === 'HEAD' && call.url.includes('/fs/files/')) {
        return new Response(null, { status: 200, headers: { 'Content-Length': '20' } })
      }
      if (call.method === 'HEAD') return notFoundResponse()
      return new Response('alpha\nTODO: beta\ngamma', { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const { stdout, exitCode } = await run('grep', [pathOf('/volume/notes.md')], ['TODO'])
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe('TODO: beta')
  })
})

describe('touch', () => {
  it('records mount-relative write keys, not the mount-prefixed path', async () => {
    const { fetch } = routedFetch((call: FetchCall) => {
      if (call.method === 'HEAD' && call.url.includes('a.txt')) return notFoundResponse()
      if (call.method === 'HEAD') return new Response(null, { status: 200 })
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetch)
    const { writes } = await run('touch', [pathOf('/volume/a.txt')])
    expect(writes).toEqual(['/a.txt'])
  })
})

describe('mkdir', () => {
  it('records mount-relative write keys, not the mount-prefixed path', async () => {
    const { fetch } = routedFetch((call: FetchCall) => {
      if (call.method === 'PUT') return new Response(null, { status: 200 })
      if (call.url.includes('newdir')) return notFoundResponse()
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const { writes } = await run('mkdir', [pathOf('/volume/newdir')])
    expect(writes).toEqual(['/newdir'])
  })
})

describe('mv', () => {
  it('same-path mv never deletes the file (PR 142)', async () => {
    const deletes: string[] = []
    const { fetch } = routedFetch((call: FetchCall) => {
      if (call.method === 'DELETE') {
        deletes.push(call.url)
        return new Response(null, { status: 200 })
      }
      if (call.method === 'HEAD' && call.url.includes('/fs/files/')) {
        return new Response(null, { status: 200, headers: { 'Content-Length': '5' } })
      }
      if (call.method === 'HEAD') return notFoundResponse()
      return new Response('hello', { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    await run('mv', [pathOf('/volume/a.txt'), pathOf('/volume/a.txt')])
    expect(deletes).toHaveLength(0)
  })
})
