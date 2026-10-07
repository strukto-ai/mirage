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
import { OpRecord } from './record.ts'
import { ExecutionNode } from '../workspace/types.ts'

describe('OpRecord', () => {
  it('stores all init fields; bytes/durationMs are mutable for streaming records', () => {
    const r = new OpRecord({
      op: 'read',
      path: '/x',
      source: 's3',
      bytes: 1024,
      timestamp: 100,
      durationMs: 12,
    })
    expect(r.op).toBe('read')
    expect(r.path).toBe('/x')
    expect(r.source).toBe('s3')
    expect(r.bytes).toBe(1024)
    expect(r.timestamp).toBe(100)
    expect(r.durationMs).toBe(12)
    r.bytes = 2048
    r.durationMs = 50
    expect(r.bytes).toBe(2048)
    expect(r.durationMs).toBe(50)
  })

  it('isCache is true only when source is "ram"', () => {
    const r = new OpRecord({
      op: 'read',
      path: '/x',
      source: 'ram',
      bytes: 0,
      timestamp: 0,
      durationMs: 0,
    })
    expect(r.isCache).toBe(true)
  })

  it('isCache is false for non-ram sources', () => {
    const r = new OpRecord({
      op: 'read',
      path: '/x',
      source: 's3',
      bytes: 0,
      timestamp: 0,
      durationMs: 0,
    })
    expect(r.isCache).toBe(false)
  })

  it('accepts zero-byte records (e.g. stat ops)', () => {
    const r = new OpRecord({
      op: 'stat',
      path: '/s3/data/file.csv',
      source: 's3',
      bytes: 0,
      timestamp: 1711800000000,
      durationMs: 5,
    })
    expect(r.bytes).toBe(0)
  })

  it('serializes only the public observation fields', () => {
    // The same fields as python's OpRecord.to_dict: the in-process mount
    // identity, the claimed value and the seal are internal.
    const r = new OpRecord({
      op: 'write',
      path: '/data/file',
      source: 's3',
      bytes: 3,
      timestamp: 1,
      durationMs: 2,
      fingerprint: 'fp',
      revision: 'v1',
      mountId: 'internal-mount',
      claimed: new TextEncoder().encode('claimed bytes'),
      sealed: true,
    })
    expect(Object.keys(r.toJSON()).sort()).toEqual(
      [
        'bytes',
        'durationMs',
        'fingerprint',
        'op',
        'path',
        'revision',
        'source',
        'timestamp',
      ].sort(),
    )
  })
})

describe('ExecutionNode records', () => {
  it('defaults records to empty array', () => {
    const node = new ExecutionNode({ command: 'cat /s3/data/a.txt', exitCode: 0 })
    expect(node.records).toEqual([])
  })

  it('includes records in toJSON output when non-empty', () => {
    const r = new OpRecord({
      op: 'read',
      path: '/s3/a.txt',
      source: 's3',
      bytes: 100,
      timestamp: 1711800000000,
      durationMs: 10,
    })
    const node = new ExecutionNode({ command: 'cat /s3/a.txt', exitCode: 0, records: [r] })
    const d = node.toJSON() as { records: Record<string, unknown>[] }
    expect(d.records).toHaveLength(1)
    expect(d.records[0]?.op).toBe('read')
  })

  it('omits records key in toJSON output when empty', () => {
    const node = new ExecutionNode({ command: 'cat /x', exitCode: 0 })
    const d = node.toJSON()
    expect(d).not.toHaveProperty('records')
  })
})
