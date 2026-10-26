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
import {
  jsonResponse,
  makeAccessor,
  notFoundResponse,
  routedFetch,
  TEST_ROOT,
  type FetchCall,
} from '../../../tests/core/databricks_volume/_test_util.ts'
import { MountMode } from '../../types.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { DatabricksVolumeVFSBase } from './databricks_volume.ts'

const MS = 1_700_000_000_000
const FROZEN_NOW_S = 1_700_000_000
const DAY_S = 86_400
const AGES_DAYS = [1, 2, 3, 10, 20]
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

// Runs one line over a fresh mount, the way the agent's shell does.
async function run(line: string): Promise<string[]> {
  const ws = new Workspace(
    { '/volume': new DatabricksVolumeVFSBase({ accessor: makeAccessor() }) },
    { mode: MountMode.READ },
  )
  try {
    const result = await ws.shell(line)
    expect([result.exitCode, result.stderrText], line).toEqual([0, ''])
    return result.stdoutText.split('\n').filter((l) => l !== '')
  } finally {
    await ws.close()
  }
}

const listDirCalls = (calls: FetchCall[]): FetchCall[] =>
  calls.filter((c) => c.method === 'GET' && c.url.includes('/fs/directories/'))

// The operand's own stat may ask; a child's never does.
const childStats = (calls: FetchCall[]): FetchCall[] =>
  calls.filter((c) => c.method === 'HEAD' && c.url.includes('/sub/'))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('databricks_volume listing API-call counts', () => {
  it.each(['', '-l', '-t', '-S'])('ls %s lists once and never stats entries', async (flags) => {
    const { fetch, calls } = routedFetch(flatRoute(5))
    vi.stubGlobal('fetch', fetch)
    await run(`ls ${flags} /volume/sub`)
    expect(listDirCalls(calls)).toHaveLength(1)
    expect(childStats(calls)).toHaveLength(0)
  })

  it('tree lists one directory per level and never stats entries', async () => {
    const { fetch, calls } = routedFetch(nestedRoute)
    vi.stubGlobal('fetch', fetch)
    await run('tree /volume/sub')
    expect(listDirCalls(calls)).toHaveLength(2)
    expect(childStats(calls)).toHaveLength(0)
  })

  it.each(['-type f', '-size +3c', '-mtime -100000'])(
    'find %s lists once and never stats children',
    async (texts) => {
      const { fetch, calls } = routedFetch(flatRoute(5))
      vi.stubGlobal('fetch', fetch)
      await run(`find /volume/sub ${texts}`)
      expect(listDirCalls(calls)).toHaveLength(1)
      expect(childStats(calls)).toHaveLength(0)
    },
  )

  it('find -mtime filters on the modified time the listing names', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(FROZEN_NOW_S * 1000)
    const { fetch, calls } = routedFetch(agedRoute)
    vi.stubGlobal('fetch', fetch)
    const names = (await run('find /volume/sub -mtime -5'))
      .filter((line) => line.endsWith('.txt'))
      .map((line) => line.split('/').pop())
      .sort()
    expect(names).toEqual(['f0.txt', 'f1.txt', 'f2.txt'])
    expect(listDirCalls(calls)).toHaveLength(1)
    expect(childStats(calls)).toHaveLength(0)
  })
})
