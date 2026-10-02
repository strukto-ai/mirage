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
import { DEFAULT_READ_TTL, MountMode, ReadPolicy } from '@struktoai/mirage-core/types'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeGraph, ME, serveGraph } from '../../core/msgraph/_test_util.ts'
import { Workspace } from '../../workspace.ts'
import { buildVfs } from '../registry.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

let graphs: FakeGraph[] = []

afterEach(async () => {
  await Promise.all(graphs.map((graph) => graph.close()))
  graphs = []
})

async function wsOf(graph: FakeGraph, policy: ReadPolicy): Promise<Workspace> {
  const vfs = await buildVfs('onedrive', { access_token: 't', graph_base_url: graph.url })
  return new Workspace({
    '/m': new Mount(vfs, { mode: MountMode.WRITE, read: { policy, ttl: DEFAULT_READ_TTL } }),
  })
}

async function out(workspace: Workspace, command: string): Promise<string> {
  const result = await workspace.shell(command)
  expect([result.exitCode, DEC.decode(result.stderr)], command).toEqual([0, ''])
  return DEC.decode(result.stdout)
}

function promote(path: string, data: Uint8Array): Uint8Array {
  if (!path.endsWith('.docx')) return data
  return new Uint8Array([...data, ...ENC.encode('<promoted/>')])
}

async function served(name: string): Promise<FakeGraph> {
  const graph = new FakeGraph({ [ME]: { [name]: ENC.encode('old\n') } })
  graphs.push(graph)
  await serveGraph(graph)
  graph.onUpload(promote)
  return graph
}

describe('onedrive written bytes', () => {
  for (const policy of [ReadPolicy.BOUNDED, ReadPolicy.FRESH]) {
    it(`a read after tee serves what the drive stored (${policy})`, async () => {
      // The upload reply reports the promoted size, so the bytes tee sent are
      // dropped and the next cat downloads what the drive holds.
      const graph = await served('a.docx')
      const ws = await wsOf(graph, policy)
      try {
        await out(ws, 'echo hi | tee /m/a.docx')
        const before = graph.fetches()
        expect(DEC.decode(graph.data(ME, 'a.docx'))).toBe('hi\n<promoted/>')
        expect(await out(ws, 'cat /m/a.docx')).toBe('hi\n<promoted/>')
        expect(graph.fetches() - before).toBe(1)
      } finally {
        await ws.close()
      }
    })

    it(`a file stored as sent stays warm after tee (${policy})`, async () => {
      // The reply agrees with the bytes sent and carries the cTag a later
      // stat reports, so the next cat downloads nothing, under fresh too.
      const graph = await served('a.txt')
      const ws = await wsOf(graph, policy)
      try {
        await out(ws, 'echo hi | tee /m/a.txt')
        const before = graph.fetches()
        expect(await out(ws, 'cat /m/a.txt')).toBe('hi\n')
        expect(graph.fetches() - before).toBe(0)
      } finally {
        await ws.close()
      }
    })

    it(`a read earlier on the line does not outlive the write (${policy})`, async () => {
      // The read stamps the pre-write cTag; storing its bytes after the line
      // would serve "old" under bounded, and cost a download under fresh.
      const graph = new FakeGraph({ [ME]: { 'a.txt': ENC.encode('old\n') } })
      graphs.push(graph)
      await serveGraph(graph)
      const ws = await wsOf(graph, policy)
      try {
        await out(ws, 'cat /m/a.txt; echo hi | tee /m/a.txt')
        const before = graph.fetches()
        expect(await out(ws, 'cat /m/a.txt')).toBe('hi\n')
        expect(graph.fetches() - before).toBe(0)
      } finally {
        await ws.close()
      }
    })
  }
})
