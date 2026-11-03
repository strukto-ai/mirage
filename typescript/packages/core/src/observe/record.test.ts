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
import { LostPaths, MUTATION_OPS, OpRecord, type OpStatus, RecordIndex } from './record.ts'
import { OwnRead } from '../cache/types.ts'
import { VersionHistory, VersionScope } from '../cache/versions.ts'
import type { MountEntry } from '../workspace/mount/mount.ts'
import { captureFingerprints } from '../workspace/snapshot/drift.ts'
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

  it('a RAM read is served by its backend', () => {
    const r = new OpRecord({
      op: 'read',
      path: '/x',
      source: 'ram',
      bytes: 0,
      timestamp: 0,
      durationMs: 0,
    })
    expect(r.served).toBe('backend')
    expect(r.changed).toBe(false)
  })

  it('a remote read defaults to backend', () => {
    const r = new OpRecord({
      op: 'read',
      path: '/x',
      source: 's3',
      bytes: 0,
      timestamp: 0,
      durationMs: 0,
    })
    expect(r.served).toBe('backend')
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
        'status',
        'errno',
        'changed',
        'served',
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
    new OpRecord({
      op: name,
      path,
      source: 's3',
      bytes: 0,
      timestamp: 0,
      durationMs: 0,
      changed: MUTATION_OPS.has(name),
    })
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

it('a failed mutation preserves the read version', () => {
  const read = new OpRecord({
    op: 'read',
    path: '/a',
    source: 'ram',
    bytes: 3,
    timestamp: 0,
    durationMs: 0,
  })
  const failed = new OpRecord({
    op: 'unlink',
    path: '/a',
    source: 'ram',
    bytes: 0,
    timestamp: 1,
    durationMs: 0,
    status: 'failed',
    errno: 13,
  })
  expect(failed.changed).toBe(false)
  expect(new RecordIndex([read, failed]).newestVersion('/a')).toBe(read)
  expect(failed.toDict()).toMatchObject({
    status: 'failed',
    errno: 13,
    changed: false,
    served: 'backend',
  })
})

const OUTCOMES: Record<string, [OpStatus, boolean]> = {
  ok: ['ok', true],
  'ok, unchanged': ['ok', false],
  failed: ['failed', false],
  partial: ['partial', true],
}

function outcome(op: string, name: string, fingerprint: string | null = null): OpRecord {
  const [status, changed] = OUTCOMES[name] ?? ['ok', true]
  return new OpRecord({
    op,
    path: '/s3/a',
    source: 's3',
    bytes: 0,
    timestamp: 1,
    durationMs: 0,
    fingerprint,
    status,
    errno: status === 'ok' ? null : 13,
    changed,
  })
}

describe('a row against the version consumers', () => {
  it.each([
    ['ok', true],
    ['ok, unchanged', false],
    ['failed', false],
    ['partial', true],
  ] as const)('a %s removal speaks for the path only when it settles', (name, settles) => {
    const read = new OpRecord({
      op: 'read',
      path: '/s3/a',
      source: 's3',
      bytes: 3,
      timestamp: 0,
      durationMs: 0,
      fingerprint: 'v1',
    })
    const gone = outcome('unlink', name)
    expect(gone.settles).toBe(settles)
    expect(new RecordIndex([read, gone]).newestVersion('/s3/a')).toBe(settles ? gone : read)
    const history = new VersionHistory()
    const scope = new VersionScope()
    history.observe(scope, 'a', read)
    history.observe(scope, 'a', gone)
    expect(history.read(scope, 'a')).toBe(settles ? OwnRead.ABSENT : 'v1')
    const mount = {
      prefix: '/s3/',
      vfs: { supportsSnapshot: true },
      revisions: new Map(),
    } as unknown as MountEntry
    const registry = { tryMountFor: () => mount, allMounts: () => [mount] }
    const pins = captureFingerprints([read, gone], registry)
    expect(pins.map((pin) => pin.path)).toEqual(settles ? [] : ['/s3/a'])
  })

  it.each([
    ['ok', true],
    ['ok, unchanged', false],
    ['failed', false],
    ['partial', false],
  ] as const)('a %s write lifts a lost mark only when it landed', (name, lifts) => {
    const sink: OpRecord[] = []
    const lost = new LostPaths(sink)
    lost.mark('/s3/a', 'v1')
    sink.push(outcome('write', name, 'v2'))
    expect(lost.holds('/s3/a')).toBe(!lifts)
  })
})
