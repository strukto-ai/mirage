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

/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest'
import { MountMode } from '../types.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { ContextScope } from '../utils/context_scope.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import {
  captureRecordingContext,
  commandRecords,
  record,
  recordStream,
  revisionFor,
  runWithRecording,
  runWithMountContext,
  runWithRevisions,
  startOp,
  withMountContext,
} from './context.ts'
import type { OpRecord } from './record.ts'

describe('runWithRecording / record / runWithMountContext', () => {
  it('record outside recording scope is a no-op', () => {
    record('read', '/a.txt', 's3', 100, startOp())
  })

  it('runWithMountContext outside recording scope runs fn and records nothing', async () => {
    const value = await runWithMountContext(async () => {
      record('read', '/a.txt', 's3', 1, startOp())
      return 7
    }, 'm1')
    expect(value).toBe(7)
    expect(recordStream('read', '/a.txt', 's3')).toBeNull()
  })

  it('captures a single record within scope', async () => {
    const [, records] = await runWithRecording(async () => {
      record('read', '/a.txt', 's3', 100, startOp())
    })
    expect(records).toHaveLength(1)
    expect(records[0]?.op).toBe('read')
    expect(records[0]?.bytes).toBe(100)
  })

  it('records after scope ends are dropped', async () => {
    const [, records] = await runWithRecording(async () => {
      record('read', '/a.txt', 's3', 100, startOp())
    })
    record('read', '/b.txt', 's3', 200, startOp())
    expect(records).toHaveLength(1)
  })

  it('captures multiple records with correct sources', async () => {
    const [, records] = await runWithRecording(async () => {
      record('read', '/a.txt', 's3', 100, startOp())
      record('write', '/b.txt', 'ram', 50, startOp())
    })
    expect(records).toHaveLength(2)
    expect(records[0]?.source).toBe('s3')
    expect(records[1]?.source).toBe('ram')
  })

  it('runWithMountContext carries mountId; undefined inherits, null clears', async () => {
    const [, records] = await runWithRecording(() =>
      runWithMountContext(async () => {
        record('read', '/s3/a.txt', 's3', 1, startOp())
        await runWithMountContext(async () => {
          record('read', '/s3/b.txt', 's3', 1, startOp())
        }, undefined)
        await runWithMountContext(async () => {
          record('read', '/s3/c.txt', 's3', 1, startOp())
        }, null)
        await runWithMountContext(async () => {
          record('read', '/db/d.txt', 'postgres', 1, startOp())
        }, 'db-id')
        record('read', '/s3/e.txt', 's3', 1, startOp())
      }, 's3-id'),
    )
    expect(records.map((r) => [r.path, r.mountId])).toEqual([
      ['/s3/a.txt', 's3-id'],
      ['/s3/b.txt', 's3-id'],
      ['/s3/c.txt', null],
      ['/db/d.txt', 'db-id'],
      ['/s3/e.txt', 's3-id'],
    ])
  })

  // Two mounts consumed concurrently must not see each other's mountId. The
  // interleave is forced: each branch records only after the other has
  // opened its own scope, which a mountId mutated on shared state would
  // already have overwritten.
  it('keeps mountId task-local across concurrent branches', async () => {
    const gate = { s3: false, db: false }
    const branch = async (key: 's3' | 'db', other: 's3' | 'db', file: string) => {
      await runWithMountContext(async () => {
        gate[key] = true
        while (!gate[other]) await new Promise((r) => setTimeout(r, 0))
        record('read', file, key, 1, startOp())
      }, `${key}-id`)
    }
    const [, records] = await runWithRecording(async () => {
      await Promise.all([branch('s3', 'db', '/s3/alpha.txt'), branch('db', 's3', '/db/beta.txt')])
    })
    expect(new Set(records.map((r) => `${r.path}=${String(r.mountId)}`))).toEqual(
      new Set(['/s3/alpha.txt=s3-id', '/db/beta.txt=db-id']),
    )
  })

  // The stream is built under `s3-id` and drained under a foreign `db-id`
  // frame, after its own scope has exited; every step must still record
  // against the mount that produced it.
  it('withMountContext keeps mountId across iterator steps under a foreign frame', async () => {
    const lazy = async function* (): AsyncGenerator<Uint8Array> {
      record('read', '/s3/a.txt', 's3', 1, startOp())
      yield new Uint8Array([1])
      record('read', '/s3/a.txt', 's3', 1, startOp())
      yield new Uint8Array([2])
    }
    const [, records] = await runWithRecording(async () => {
      const wrapped = await runWithMountContext(
        async () => withMountContext(lazy(), 's3-id'),
        's3-id',
      )
      await runWithMountContext(async () => {
        for await (const _chunk of wrapped) void _chunk
      }, 'db-id')
    })
    expect(records.map((r) => r.mountId)).toEqual(['s3-id', 's3-id'])
  })
})

describe('OpRecord: fingerprint + revision', () => {
  it('record() persists fingerprint and revision on the OpRecord', async () => {
    const [, records] = await runWithRecording(async () => {
      record('read', '/a.txt', 's3', 100, startOp(), {
        fingerprint: 'abc',
        revision: 'v1',
      })
    })
    expect(records.length).toBe(1)
    expect(records[0]?.fingerprint).toBe('abc')
    expect(records[0]?.revision).toBe('v1')
  })

  it('record() defaults fingerprint and revision to null', async () => {
    const [, records] = await runWithRecording(async () => {
      record('read', '/a.txt', 's3', 100, startOp())
    })
    expect(records[0]?.fingerprint).toBeNull()
    expect(records[0]?.revision).toBeNull()
  })

  it('recordStream() persists fingerprint and revision', async () => {
    let rec: ReturnType<typeof recordStream> = null
    const [, records] = await runWithRecording(async () => {
      rec = recordStream('read', '/a.txt', 's3', { fingerprint: 'abc', revision: 'v1' })
    })
    expect(rec).not.toBeNull()
    expect(records[0]?.fingerprint).toBe('abc')
    expect(records[0]?.revision).toBe('v1')
  })

  it('recordStream() allows late mutation of fp/rev on the returned record', async () => {
    const [, records] = await runWithRecording(async () => {
      const rec = recordStream('read', '/a.txt', 's3')
      if (rec !== null) {
        rec.fingerprint = 'late-fp'
        rec.revision = 'late-rev'
      }
    })
    expect(records[0]?.fingerprint).toBe('late-fp')
    expect(records[0]?.revision).toBe('late-rev')
  })
})

describe('revisions context', () => {
  it('revisionFor returns null outside any revisions scope', () => {
    expect(revisionFor('/s3/a')).toBeNull()
  })

  it('revisionFor returns null when null is passed as the map', async () => {
    await runWithRevisions(null, async () => {
      expect(revisionFor('/s3/a')).toBeNull()
    })
  })

  it('runWithRevisions exposes the installed map; restores prior state after fn', async () => {
    await runWithRevisions(
      new Map([
        ['/s3/a', 'v1'],
        ['/s3/b', 'v2'],
      ]),
      async () => {
        expect(revisionFor('/s3/a')).toBe('v1')
        expect(revisionFor('/s3/b')).toBe('v2')
        expect(revisionFor('/s3/c')).toBeNull()
      },
    )
    expect(revisionFor('/s3/a')).toBeNull()
  })

  it('runWithRevisions works independently of runWithRecording', async () => {
    await runWithRevisions(new Map([['/s3/a', 'v1']]), async () => {
      expect(revisionFor('/s3/a')).toBe('v1')
    })
  })
})

// The recorder stores a path as given. A read op registered on a RAM mount at
// /m records one path outside the mount and one inside it; dispatched through
// the workspace, neither may gain the mount's prefix.
describe('recorder stores the path as given', () => {
  it('record keeps both paths through a dispatched op', async () => {
    const ws = new Workspace({ '/m': new RAMVFS() }, { mode: MountMode.WRITE })
    let calls = 0
    ws.opsRegistry.register({
      name: 'read',
      vfs: 'ram',
      filetype: null,
      write: false,
      fn: async () => {
        calls += 1
        record('read', '/x/y', 'ram', 1, startOp())
        record('read', '/m/k.txt', 'ram', 1, startOp())
        return new Uint8Array([1])
      },
    })
    try {
      const [, records] = await runWithRecording(() => ws.dispatch('read', '/m/k.txt'))
      expect(calls).toBe(1)
      expect(records.map((r) => r.path)).toEqual(['/x/y', '/m/k.txt'])
    } finally {
      await ws.close()
    }
  })

  it('recordStream keeps both paths through a dispatched op', async () => {
    const ws = new Workspace({ '/m': new RAMVFS() }, { mode: MountMode.WRITE })
    let calls = 0
    ws.opsRegistry.register({
      name: 'read',
      vfs: 'ram',
      filetype: null,
      write: false,
      fn: async () => {
        calls += 1
        recordStream('read', '/x/y', 'ram')
        recordStream('read', '/m/k.txt', 'ram')
        return new Uint8Array([1])
      },
    })
    try {
      const [, records] = await runWithRecording(() => ws.dispatch('read', '/m/k.txt'))
      expect(calls).toBe(1)
      expect(records.map((r) => r.path)).toEqual(['/x/y', '/m/k.txt'])
    } finally {
      await ws.close()
    }
  })
})

describe('commandRecords', () => {
  it("collects only its own command's records", async () => {
    let inner: OpRecord[] = []
    let outer: OpRecord[] = []
    const [, sink] = await runWithRecording(async () => {
      await commandRecords(async (mine) => {
        outer = mine
        record('write', '/a', 'ram', 1, startOp())
        await commandRecords(async (nested) => {
          inner = nested
          record('write', '/b', 'ram', 1, startOp())
          recordStream('write', '/c', 'ram')
        })
        record('write', '/post', 'ram', 1, startOp())
      })
    })
    expect(inner.map((r) => r.path)).toEqual(['/b', '/c'])
    expect(outer.map((r) => r.path)).toEqual(['/a', '/post'])
    expect(sink.map((r) => r.path)).toEqual(['/a', '/b', '/c', '/post'])
    // The marks land on the line's own records, so the lists share them.
    for (const r of [...inner, ...outer]) expect(sink).toContain(r)
  })

  it('stays empty outside a recording scope', async () => {
    let mine: OpRecord[] = []
    await commandRecords(async (records) => {
      mine = records
      record('write', '/a', 'ram', 1, startOp())
      expect(recordStream('write', '/b', 'ram')).toBeNull()
    })
    expect(mine).toEqual([])
  })

  // Each command records only after the other has opened its own list.
  it('is task-local across concurrent commands', async () => {
    const opened = new Set<string>()
    const recorded = new Set<string>()
    const command = async (me: string, other: string, file: string): Promise<string[]> =>
      commandRecords(async (mine) => {
        opened.add(me)
        while (!opened.has(other)) await new Promise((r) => setTimeout(r, 0))
        record('write', file, 'ram', 1, startOp())
        recorded.add(me)
        // Both lists stay open until both have recorded, so a shared variable
        // that restores the previous list on exit still holds the other
        // command's list when this one records.
        while (!recorded.has(other)) await new Promise((r) => setTimeout(r, 0))
        return mine.map((r) => r.path)
      })
    const [[first, second]] = await runWithRecording(async () =>
      Promise.all([command('A', 'B', '/a/x.txt'), command('B', 'A', '/b/y.txt')]),
    )
    expect([first, second]).toEqual([['/a/x.txt'], ['/b/y.txt']])
  })

  // A lazy stream pull or a runtime hop runs under a captured context after
  // the command's own frame has exited; its record is still the command's.
  it('rides a captured recording context', async () => {
    const [mine] = await runWithRecording(async () => {
      let captured: ContextScope | undefined
      const list = await commandRecords(async (records) => {
        captured = new ContextScope(captureRecordingContext())
        return records
      })
      await captured?.run(async () => {
        record('write', '/late', 'ram', 1, startOp())
      })
      return list
    })
    expect(mine.map((r) => r.path)).toEqual(['/late'])
  })
})
