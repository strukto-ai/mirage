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
import {
  record,
  recordStream,
  revisionFor,
  runWithRecording,
  runWithRevisions,
  setVirtualPrefix,
} from './context.ts'

describe('runWithRecording / record / setVirtualPrefix', () => {
  it('record outside recording scope is a no-op', () => {
    record('read', '/a.txt', 's3', 100, 0)
  })

  it('captures a single record within scope', async () => {
    const [, records] = await runWithRecording(async () => {
      record('read', '/a.txt', 's3', 100, 0)
    })
    expect(records).toHaveLength(1)
    expect(records[0]?.op).toBe('read')
    expect(records[0]?.bytes).toBe(100)
  })

  it('records after scope ends are dropped', async () => {
    const [, records] = await runWithRecording(async () => {
      record('read', '/a.txt', 's3', 100, 0)
    })
    record('read', '/b.txt', 's3', 200, 0)
    expect(records).toHaveLength(1)
  })

  it('captures multiple records with correct sources', async () => {
    const [, records] = await runWithRecording(async () => {
      record('read', '/a.txt', 's3', 100, 0)
      record('write', '/b.txt', 'ram', 50, 0)
    })
    expect(records).toHaveLength(2)
    expect(records[0]?.source).toBe('s3')
    expect(records[1]?.source).toBe('ram')
  })

  it('prepends virtual prefix when path lacks it', async () => {
    const [, records] = await runWithRecording(async () => {
      setVirtualPrefix('/s3')
      record('read', '/data/file.json', 's3', 100, 0)
    })
    expect(records[0]?.path).toBe('/s3/data/file.json')
  })

  it('leaves path unchanged when prefix is empty', async () => {
    const [, records] = await runWithRecording(async () => {
      record('read', '/data/file.json', 's3', 100, 0)
    })
    expect(records[0]?.path).toBe('/data/file.json')
  })

  it('does not double-apply prefix when path already has it', async () => {
    const [, records] = await runWithRecording(async () => {
      setVirtualPrefix('/s3')
      record('read', '/s3/data/file.json', 's3', 100, 0)
    })
    expect(records[0]?.path).toBe('/s3/data/file.json')
  })
})

describe('OpRecord: fingerprint + revision', () => {
  it('record() persists fingerprint and revision on the OpRecord', async () => {
    const [, records] = await runWithRecording(async () => {
      record('read', '/a.txt', 's3', 100, performance.now(), {
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
      record('read', '/a.txt', 's3', 100, performance.now())
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
