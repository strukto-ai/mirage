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
import { OpRecord } from '../observe/record.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode, ResourceName } from '../types.ts'
import { Workspace } from './workspace.ts'

function record(source: string, bytes: number): OpRecord {
  return new OpRecord({
    op: 'read',
    path: '/data/a.txt',
    source,
    bytes,
    timestamp: 1,
    durationMs: 1,
  })
}

describe('Workspace record accounting', () => {
  it('splits records and bytes by network vs cache', () => {
    const ws = new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.WRITE })
    ws.records.push(record(ResourceName.S3, 100))
    ws.records.push(record(ResourceName.RAM, 30))
    ws.records.push(record(ResourceName.S3, 7))
    expect(ws.networkBytes).toBe(107)
    expect(ws.cacheBytes).toBe(30)
    expect(ws.networkRecords.map((r) => r.bytes)).toEqual([100, 7])
    expect(ws.cacheRecords.map((r) => r.bytes)).toEqual([30])
  })

  it('returns zeros on a fresh workspace', () => {
    const ws = new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.WRITE })
    expect(ws.networkBytes).toBe(0)
    expect(ws.cacheBytes).toBe(0)
    expect(ws.networkRecords).toEqual([])
    expect(ws.cacheRecords).toEqual([])
  })

  it('WorkspaceFS ops land in ws.records', async () => {
    const ws = new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.WRITE })
    await ws.fs.writeFile('/data/a.txt', 'hello')
    await ws.fs.readFile('/data/a.txt')
    await ws.fs.readdir('/data')
    await ws.fs.stat('/data/a.txt')
    const ops = ws.records.map((r) => r.op)
    expect(ops).toEqual(['write', 'read', 'readdir', 'stat'])
    expect(ws.records[0]?.bytes).toBe(5)
    expect(ws.records[1]?.bytes).toBe(5)
    expect(ws.records[0]?.path).toBe('/data/a.txt')
    expect(ws.records.every((r) => r.source === 'ram')).toBe(true)
  })
})
