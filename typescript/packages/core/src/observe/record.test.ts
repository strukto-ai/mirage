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
import { OpLog, OpRecord, RecordIndex } from './record.ts'
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
    // identity is internal.
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
    })
    expect(JSON.parse(JSON.stringify(r))).toEqual(r.toDict())
    expect(Object.keys(r.toDict()).sort()).toEqual(
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
    const d = node.toDict() as { records: Record<string, unknown>[] }
    expect(d.records).toHaveLength(1)
    expect(d.records[0]?.op).toBe('read')
  })

  it('omits records key in toJSON output when empty', () => {
    const node = new ExecutionNode({ command: 'cat /x', exitCode: 0 })
    const d = node.toDict()
    expect(d).not.toHaveProperty('records')
  })
})

describe('RecordIndex.newestVersion', () => {
  const op = (name: string, path: string): OpRecord =>
    new OpRecord({ op: name, path, source: 's3', bytes: 0, timestamp: 0, durationMs: 0 })
  it.each([
    ['a read', [['read', '/a']], '/a', 0],
    [
      'the newer of two',
      [
        ['read', '/a'],
        ['write', '/a'],
      ],
      '/a',
      1,
    ],
    [
      'a stat counts for nothing',
      [
        ['read', '/a'],
        ['stat', '/a'],
      ],
      '/a',
      0,
    ],
    [
      'a later subtree retract above',
      [
        ['read', '/d/a'],
        ['rm_r', '/d'],
      ],
      '/d/a',
      1,
    ],
    [
      'a read after the retract',
      [
        ['rm_r', '/d'],
        ['read', '/d/a'],
      ],
      '/d/a',
      1,
    ],
    [
      'a sibling prefix is not above',
      [
        ['read', '/d/a'],
        ['rm_r', '/dx'],
      ],
      '/d/a',
      0,
    ],
    [
      'a retract among others',
      [
        ['read', '/d/a'],
        ['rename_prefix', '/d'],
        ['read', '/e'],
      ],
      '/d/a',
      1,
    ],
    [
      'the later of two retracts',
      [
        ['rm_r', '/d'],
        ['read', '/d/a'],
        ['rm_r', '/d'],
      ],
      '/d/a',
      2,
    ],
    ['nothing for the path', [['read', '/b']], '/a', null],
  ] as const)('%s', (_name, ops, key, newest) => {
    const records = ops.map(([name, path]) => op(name, path))
    expect(new RecordIndex(records).newestVersion(key)).toBe(
      newest === null ? null : records[newest],
    )
  })

  it('reads each record once', () => {
    // Append-only: a lookup costs the records since the last one.
    const records = [op('read', '/a')]
    const index = new RecordIndex(records)
    index.newestVersion('/a')
    records[0] = op('read', '/b')
    expect(index.newestVersion('/b')).toBeNull()
  })
})

describe('OpLog', () => {
  it('drops the oldest records that change no pin', () => {
    const rec = (op: string, source = 'disk', fingerprint: string | null = null): OpRecord =>
      new OpRecord({
        op,
        path: `/data/${op}`,
        source,
        bytes: 10,
        timestamp: 0,
        durationMs: 0,
        fingerprint,
      })
    const log = new OpLog(4)
    const holds = (held: OpRecord[]): void => {
      expect(log.records).toHaveLength(held.length)
      log.records.forEach((r, i) => {
        expect(r).toBe(held[i])
      })
    }
    const [stamp, gone, kept] = [rec('read', 's3', 'etag'), rec('unlink'), rec('read')]
    log.add([rec('read'), stamp, rec('stat', 'ram'), gone, kept])
    expect(log.records).toHaveLength(5)
    const newest = [rec('read'), rec('readdir')]
    log.add(newest)
    holds([stamp, gone, kept, ...newest])
    expect([log.networkBytes, log.cacheBytes]).toEqual([60, 10])
    // A later trim reads on from the oldest it kept, past the pins.
    const more = [rec('stat'), rec('stat'), rec('stat')]
    log.add(more)
    holds([stamp, gone, ...more])
    expect([log.networkBytes, log.cacheBytes]).toEqual([90, 10])
  })

  // A later stamp of a path overrules the earlier ones of the same mount, a
  // later drop the earlier drops there, and a later prefix op an earlier
  // prefix op and drop there, so reading or writing a file again leaves one
  // record of it. A stamp of another mount and a prefix op followed by a
  // drop both stay, and a record that arrives late with an earlier time is
  // overruled as it lands.
  it('drops a record a later one overrules', () => {
    const rec = (
      op: string,
      path: string,
      timestamp: number,
      fingerprint: string | null = null,
      mountId: string | null = null,
    ): OpRecord =>
      new OpRecord({
        op,
        path,
        source: 's3',
        bytes: 10,
        timestamp,
        durationMs: 0,
        fingerprint,
        mountId,
      })
    const log = new OpLog(3)
    const holds = (held: OpRecord[]): void => {
      expect(log.records).toHaveLength(held.length)
      log.records.forEach((r, i) => {
        expect(r).toBe(held[i])
      })
    }
    const read = rec('read', '/s3/a', 1, 'v1')
    const replaced = rec('read', '/s3/a', 2, 'v1', 'gone')
    const appended = rec('append', '/s3/b', 3)
    const swept = rec('rm_r', '/s3/c', 4)
    log.add([read, replaced, appended, swept])
    holds([read, replaced, appended, swept])
    const again = rec('read', '/s3/a', 5, 'v2')
    const removed = rec('unlink', '/s3/b', 6)
    const inside = rec('append', '/s3/c', 7)
    log.add([again, removed, inside, rec('read', '/s3/a', 0, 'v0')])
    holds([replaced, swept, again, removed, inside])
    const resweep = rec('rm_r', '/s3/c', 9)
    const others = ['d', 'e', 'f'].map((name) => rec('read', `/s3/${name}`, 10, 'v'))
    log.add([resweep, ...others])
    holds([replaced, again, removed, resweep, ...others])
    expect([log.networkBytes, log.cacheBytes]).toEqual([120, 0])
  })

  // The cap on the rest holds at every add, however many pins the op log
  // keeps: a pass over the pins waits for half as many more, and the rest is
  // trimmed without it.
  it('holds its cap of the rest beside many pins', () => {
    const rec = (op: string, path: string, fingerprint: string | null = null): OpRecord =>
      new OpRecord({ op, path, source: 's3', bytes: 1, timestamp: 0, durationMs: 0, fingerprint })
    const log = new OpLog(4)
    const pins = Array.from({ length: 200 }, (_, i) => rec('read', `/s3/${String(i)}`, 'v'))
    log.add(pins)
    for (let i = 0; i < 20; i++) {
      log.add([rec('stat', `/s3/${String(i)}`)])
      expect(log.records.filter((r) => r.fingerprint === null).length).toBeLessThanOrEqual(4)
    }
    log.records.slice(0, 200).forEach((r, i) => {
      expect(r).toBe(pins[i])
    })
    expect(log.networkBytes).toBe(220)
  })
})
