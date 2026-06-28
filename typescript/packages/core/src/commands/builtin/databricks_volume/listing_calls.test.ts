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
import { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import {
  jsonResponse,
  makeAccessor,
  notFoundResponse,
  routedFetch,
  TEST_ROOT,
  type FetchCall,
} from '../../../core/databricks_volume/_test_util.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { materialize } from '../../../io/types.ts'
import type { Resource } from '../../../resource/base.ts'
import type { RegisteredCommand } from '../../config.ts'
import { PathSpec } from '../../../types.ts'
import { DATABRICKS_VOLUME_COMMANDS } from './index.ts'

const MS = 1_700_000_000_000
const FROZEN_NOW_S = 1_700_000_000
const DAY_S = 86_400
const AGES_DAYS = [1, 2, 3, 10, 20]
const DEC = new TextDecoder()

function cmdOf(name: string): RegisteredCommand {
  const cmd = DATABRICKS_VOLUME_COMMANDS.find((c) => c.name === name)
  if (cmd === undefined) throw new Error(`${name} not registered`)
  return cmd
}

function pathOf(original: string): PathSpec {
  return PathSpec.fromStrPath(original, '/volume')
}

function flatContents(count: number): { contents: unknown[] } {
  return {
    contents: Array.from({ length: count }, (_, i) => ({
      path: `${TEST_ROOT}/sub/f${String(i)}.txt`,
      file_size: i + 1,
      last_modified: MS + i * 1000,
    })),
  }
}

function nestedRoute(call: FetchCall): Response {
  if (call.method === 'GET' && call.url.includes('/fs/directories/')) {
    if (call.url.includes('/sub/inner')) {
      return jsonResponse({
        contents: [{ path: `${TEST_ROOT}/sub/inner/b.txt`, file_size: 2, last_modified: MS }],
      })
    }
    return jsonResponse({
      contents: [
        { path: `${TEST_ROOT}/sub/a.txt`, file_size: 1, last_modified: MS },
        { path: `${TEST_ROOT}/sub/inner`, is_directory: true },
      ],
    })
  }
  if (call.method === 'HEAD' && call.url.includes('/fs/directories/')) {
    return new Response(null, { status: 200 })
  }
  return notFoundResponse()
}

function flatRoute(count: number): (call: FetchCall) => Response {
  return (call) => {
    if (call.method === 'GET' && call.url.includes('/fs/directories/')) {
      return jsonResponse(flatContents(count))
    }
    if (call.method === 'HEAD' && call.url.includes('/fs/directories/')) {
      return new Response(null, { status: 200 })
    }
    return notFoundResponse()
  }
}

function agedRoute(call: FetchCall): Response {
  if (call.method === 'GET' && call.url.includes('/fs/directories/')) {
    return jsonResponse({
      contents: AGES_DAYS.map((age, i) => ({
        path: `${TEST_ROOT}/sub/f${String(i)}.txt`,
        file_size: i + 1,
        last_modified: (FROZEN_NOW_S - age * DAY_S) * 1000,
      })),
    })
  }
  if (call.method === 'HEAD' && call.url.includes('/fs/directories/')) {
    return new Response(null, { status: 200 })
  }
  return notFoundResponse()
}

async function findText(
  paths: PathSpec[],
  texts: string[],
  index: IndexCacheStore,
): Promise<string> {
  const cmd = cmdOf('find')
  const result = await cmd.fn(makeAccessor(), paths, texts, {
    stdin: null,
    flags: {},
    filetypeFns: null,
    cwd: '/',
    resource: null as unknown as Resource,
    index,
  })
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf)
}

async function runCmd(
  name: string,
  paths: PathSpec[],
  texts: string[],
  flags: Record<string, string | boolean | string[]>,
  index: IndexCacheStore,
): Promise<void> {
  const cmd = cmdOf(name)
  await cmd.fn(makeAccessor(), paths, texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: null as unknown as Resource,
    index,
  })
}

const listDirCalls = (calls: FetchCall[]): FetchCall[] =>
  calls.filter((c) => c.method === 'GET' && c.url.includes('/fs/directories/'))

const headFileCalls = (calls: FetchCall[]): FetchCall[] =>
  calls.filter((c) => c.method === 'HEAD' && c.url.includes('/fs/files/'))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('databricks_volume listing API-call counts', () => {
  it.each([
    ['ls', {}],
    ['ls -l', { args_l: true }],
    ['ls -t', { t: true }],
    ['ls -S', { S: true }],
  ])('%s lists once and never stats entries', async (_label, flags) => {
    const { fetch, calls } = routedFetch(flatRoute(5))
    vi.stubGlobal('fetch', fetch)
    await runCmd('ls', [pathOf('/volume/sub')], [], flags, new RAMIndexCacheStore())
    expect(listDirCalls(calls)).toHaveLength(1)
    expect(headFileCalls(calls)).toHaveLength(0)
  })

  it('tree lists one directory per level and never stats entries', async () => {
    const { fetch, calls } = routedFetch(nestedRoute)
    vi.stubGlobal('fetch', fetch)
    await runCmd('tree', [pathOf('/volume/sub')], [], {}, new RAMIndexCacheStore())
    expect(listDirCalls(calls)).toHaveLength(2)
    expect(headFileCalls(calls)).toHaveLength(0)
  })

  it.each([
    ['find -type f', ['-type', 'f']],
    ['find -size +3c', ['-size', '+3c']],
    ['find -mtime -100000', ['-mtime', '-100000']],
  ])('%s lists once and never stats children', async (_label, texts) => {
    const { fetch, calls } = routedFetch(flatRoute(5))
    vi.stubGlobal('fetch', fetch)
    await runCmd('find', [pathOf('/volume/sub')], texts, {}, new RAMIndexCacheStore())
    expect(listDirCalls(calls)).toHaveLength(1)
    const childStats = headFileCalls(calls).filter((c) => c.url.includes('/sub/f'))
    expect(childStats).toHaveLength(0)
  })

  it('find -mtime filters on the modified time served from the index', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(FROZEN_NOW_S * 1000)
    const { fetch, calls } = routedFetch(agedRoute)
    vi.stubGlobal('fetch', fetch)
    const stdout = await findText(
      [pathOf('/volume/sub')],
      ['-mtime', '-5'],
      new RAMIndexCacheStore(),
    )
    const names = stdout
      .split('\n')
      .filter((line) => line.endsWith('.txt'))
      .map((line) => line.split('/').pop())
      .sort()
    expect(names).toEqual(['f0.txt', 'f1.txt', 'f2.txt'])
    expect(listDirCalls(calls)).toHaveLength(1)
    expect(headFileCalls(calls).filter((c) => c.url.includes('/sub/f'))).toHaveLength(0)
  })
})
