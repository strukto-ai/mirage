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
import { ContentType, FileType, PathSpec, type FileStat } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { LangfuseApiError, type LangfuseTransport } from './client.ts'
import { jsonBytes } from '../render/json.ts'
import { LangfuseVFS } from '../../vfs/langfuse/langfuse.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { stat } from './stat.ts'

// A trace fetch the table does not hold is the API's 404, the way the
// service answers an id it does not have; any other path lists nothing.
class StaticTransport implements LangfuseTransport {
  readonly paths: string[] = []

  constructor(private readonly bodies: Record<string, unknown>) {}

  request(path: string): Promise<unknown> {
    this.paths.push(path)
    const body = this.bodies[path]
    if (body !== undefined) return Promise.resolve(body)
    if (path.startsWith('/api/public/traces/')) {
      return Promise.reject(new LangfuseApiError('not found', [], 404))
    }
    return Promise.resolve({ data: [] })
  }
}

function accessor(transport: LangfuseTransport) {
  return new LangfuseAccessor(transport)
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: stripSlash(virtual) })
}

// `path`'s stat through a mount, which lists its parent to hand the backend
// the row there.
async function mountedStat(over: LangfuseAccessor, path: string): Promise<FileStat> {
  const vfs = Object.assign(new LangfuseVFS({ publicKey: 'pk', secretKey: 'sk' }), {
    accessor: over,
  })
  const ws = new Workspace({ '/lf/': vfs })
  try {
    return (await ws.dispatch('stat', `/lf${path}`)) as FileStat
  } finally {
    await ws.close()
  }
}

const TRACES = { '/api/public/traces': { data: [{ id: 'present' }] } }
const PROMPTS = {
  '/api/public/v2/prompts': { data: [{ name: 'greeting', versions: [1], type: 'text' }] },
}

describe('langfuse stat existence', () => {
  it('stats a trace that appears in its parent listing', async () => {
    const s = await mountedStat(accessor(new StaticTransport(TRACES)), '/traces/present.json')
    expect(s.content).toBe(ContentType.JSON)
    expect(s.name).toBe('present.json')
  })

  it('raises ENOENT for a trace absent from the listing', async () => {
    // A recognizable path shape is not evidence the trace exists: an id
    // absent from the parent listing is asked of the API (the listing is
    // bounded), and the API's 404 is ENOENT, not a confident stat.
    await expect(
      mountedStat(accessor(new StaticTransport(TRACES)), '/traces/absent.json'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('raises ENOENT for a prompt version that was never published', async () => {
    await expect(
      mountedStat(accessor(new StaticTransport(PROMPTS)), '/prompts/greeting/9.json'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stats a published prompt version', async () => {
    const s = await mountedStat(accessor(new StaticTransport(PROMPTS)), '/prompts/greeting/1.json')
    expect(s.content).toBe(ContentType.JSON)
  })

  it('stats the mount root without consulting the api', async () => {
    const s = await stat(accessor(new StaticTransport({})), spec('/'))
    expect(s.type).toBe(FileType.DIRECTORY)
  })

  it('stats a top-level directory without consulting the api', async () => {
    const s = await stat(accessor(new StaticTransport({})), spec('/traces'))
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.name).toBe('traces')
  })
})

// Mirrors python's test_stat_finds_a_trace_the_bounded_listing_left_out and
// test_stat_refuses_another_sessions_trace.
describe('langfuse stat of a trace the bounded listing left out', () => {
  it('probes the trace by id and sizes it from the fetch', async () => {
    const trace = { id: 't_old', name: 'chat' }
    const transport = new StaticTransport({
      '/api/public/traces': { data: [{ id: 't_new' }] },
      '/api/public/traces/t_old': trace,
    })
    const bounded = new LangfuseAccessor(transport, { defaultTraceLimit: 1 })
    const listed = await mountedStat(bounded, '/traces/t_new.json')
    expect(transport.paths).toEqual(['/api/public/traces'])
    const older = await mountedStat(bounded, '/traces/t_old.json')
    expect(listed.type).toBe(FileType.FILE)
    expect(listed.size).toBeNull()
    expect(older.type).toBe(FileType.FILE)
    expect(older.content).toBe(ContentType.JSON)
    expect(older.size).toBe(jsonBytes(trace).byteLength)
  })

  it("refuses another session's trace", async () => {
    const transport = new StaticTransport({
      '/api/public/sessions': { data: [{ id: 's1' }] },
      '/api/public/traces/t1': { id: 't1', sessionId: 's2' },
    })
    await expect(mountedStat(accessor(transport), '/sessions/s1/t1.json')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
