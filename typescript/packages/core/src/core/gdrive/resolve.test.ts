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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DriveModule from '../google/drive.ts'

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  const { driveModuleMock } = await import('./_test_util.ts')
  return driveModuleMock(actual)
})

import type { FakeDrive } from './_test_util.ts'
import {
  DOC_MIME,
  addCollidingPair,
  makeGDriveAccessor,
  makeScopedGDriveAccessor,
  resetFakeDrive,
} from './_test_util.ts'
import { PathSpec } from '../../types.ts'
import { GoogleApiError } from '../google/client.ts'
import {
  driveTargetName,
  duplicateRank,
  eaccesOnDenied,
  pickDuplicate,
  queryCandidates,
  ranksAbove,
  renderedName,
  resolveDir,
  resolveKey,
} from './resolve.ts'

const FOLDER_MIME_TEST = 'application/vnd.google-apps.folder'

const ENC = new TextEncoder()
let fake: FakeDrive
const accessor = makeGDriveAccessor()

beforeEach(() => {
  fake = resetFakeDrive()
})

describe('gdrive resolve', () => {
  it('resolves nested paths', async () => {
    const a = fake.folder('a')
    const b = fake.folder('b', a)
    const id = fake.add('f.txt', b, undefined, ENC.encode('x'))
    const node = await resolveKey(accessor, 'a/b/f.txt')
    expect(node?.id).toBe(id)
  })

  it('returns null for missing paths', async () => {
    fake.folder('a')
    expect(await resolveKey(accessor, 'a/missing.txt')).toBeNull()
    expect(await resolveKey(accessor, 'nope/f.txt')).toBeNull()
  })

  it('file in the middle raises ENOTDIR', async () => {
    fake.add('f.txt', 'root', undefined, ENC.encode('x'))
    await expect(resolveKey(accessor, 'f.txt/child')).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('resolves native suffixes', async () => {
    const id = fake.add('Report', 'root', DOC_MIME)
    const node = await resolveKey(accessor, 'Report.gdoc.json')
    expect(node?.id).toBe(id)
  })

  for (const literalFirst of [true, false]) {
    for (const newer of ['literal', 'native'] as const) {
      it(`ranks a literal name against a rendered one (${newer} newer, literal listed ${
        literalFirst ? 'first' : 'second'
      })`, async () => {
        // A binary file literally named `x.gdoc.json` and a Google Doc
        // named `x` render as one vfs name and are found by two
        // different queries. Answering with the first query that
        // matched made the resolver pick by query order while readdir
        // picked by time, so liveIdentity could name one item and the
        // read the other.
        const [literal, doc] = addCollidingPair(fake, literalFirst, newer)
        const node = await resolveKey(accessor, 'x.gdoc.json')
        expect(node?.id).toBe(newer === 'literal' ? literal : doc)
      })
    }
  }

  it('breaks a tie between the two shapes by id, as the listing does', async () => {
    // Kind is not part of the rank, so equal stamps fall through to the
    // id -- the same tiebreak collapseDuplicates applies, which is the
    // only reason the two agree here at all.
    const literal = fake.add('x.gdoc.json', 'root', undefined, ENC.encode('raw'))
    const doc = fake.add('x', 'root', DOC_MIME)
    const node = await resolveKey(accessor, 'x.gdoc.json')
    expect(node?.id).toBe(literal > doc ? literal : doc)
  })

  it('skips an item that renders under another name', async () => {
    // The literal query matches a Drive *name*, and a Google Doc named
    // `x.gdoc.json` renders as `x.gdoc.json.gdoc.json`: it is another
    // path's item, and answering with it named a file no listing puts
    // here.
    const doc = fake.add('x.gdoc.json', 'root', DOC_MIME)
    expect(await resolveKey(accessor, 'x.gdoc.json')).toBeNull()
    expect((await resolveKey(accessor, 'x.gdoc.json.gdoc.json'))?.id).toBe(doc)
  })

  it('renderedName appends the suffix a google-apps file is listed under', () => {
    expect(renderedName('Report', DOC_MIME)).toBe('Report.gdoc.json')
    expect(renderedName('a.txt', 'text/plain')).toBe('a.txt')
    expect(renderedName('d', FOLDER_MIME_TEST)).toBe('d')
    // The rule composes, which is why the resolver has to filter on it:
    // a native doc named like a rendered one is not that rendered one.
    expect(renderedName('x.gdoc.json', DOC_MIME)).toBe('x.gdoc.json.gdoc.json')
  })

  it('resolveDir handles root and error cases', async () => {
    expect(await resolveDir(accessor, '', '/')).toEqual(['root', null])
    const d = fake.folder('d')
    expect((await resolveDir(accessor, 'd', '/d'))[0]).toBe(d)
    fake.add('f.txt', 'root', undefined, ENC.encode('x'))
    await expect(resolveDir(accessor, 'f.txt', '/f.txt')).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
    await expect(resolveDir(accessor, 'missing', '/missing')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('queryCandidates and driveTargetName', () => {
    expect(queryCandidates('plain.txt')).toEqual([['plain.txt', null]])
    const cands = queryCandidates('r.gdoc.json')
    expect(cands[0]).toEqual(['r.gdoc.json', null])
    expect(cands).toContainEqual(['r', DOC_MIME])
    const doc = { id: '1', name: 'r', mimeType: DOC_MIME, driveId: null }
    const plain = { id: '2', name: 'f', mimeType: 'text/plain', driveId: null }
    expect(driveTargetName('new.gdoc.json', doc)).toBe('new')
    expect(driveTargetName('new.gdoc.json', plain)).toBe('new.gdoc.json')
    expect(driveTargetName('new.txt', doc)).toBe('new.txt')
  })
})

describe('gdrive resolve with a folder scope', () => {
  it('resolves relative to the configured folder', async () => {
    const scope = fake.folder('scope')
    const inner = fake.add('f.txt', scope, undefined, ENC.encode('in'))
    fake.add('f.txt', 'root', undefined, ENC.encode('out'))
    const scoped = makeScopedGDriveAccessor(scope)
    const node = await resolveKey(scoped, 'f.txt')
    expect(node?.id).toBe(inner)
    expect(await resolveDir(scoped, '', '/')).toEqual([scope, null])
  })
})

describe('gdrive resolve with a shared-drive scope', () => {
  it('threads the root driveId and memoizes the lookup', async () => {
    const scope = fake.add('team', 'root', FOLDER_MIME_TEST, new Uint8Array(0), 'd1')
    const inner = fake.add('f.txt', scope, undefined, ENC.encode('in'), 'd1')
    const scoped = makeScopedGDriveAccessor(scope)
    expect(await resolveDir(scoped, '', '/')).toEqual([scope, 'd1'])
    expect(await resolveDir(scoped, '', '/')).toEqual([scope, 'd1'])
    const node = await resolveKey(scoped, 'f.txt')
    expect(node?.id).toBe(inner)
    expect(node?.driveId).toBe('d1')
  })
})

describe('eaccesOnDenied', () => {
  it('maps a 403 to EACCES on the operand, passes other errors through', async () => {
    const spec = PathSpec.fromStrPath('/gd/a.txt')
    const denied = eaccesOnDenied(async (_a: unknown, _p: PathSpec) => {
      await Promise.resolve()
      throw new GoogleApiError('denied', 403)
    })
    const serverError = eaccesOnDenied(async (_a: unknown, _p: PathSpec) => {
      await Promise.resolve()
      throw new GoogleApiError('boom', 500)
    })
    await expect(denied(null, spec)).rejects.toMatchObject({
      code: 'EACCES',
      message: expect.stringContaining('/gd/a.txt') as string,
    })
    await expect(serverError(null, spec)).rejects.toBeInstanceOf(GoogleApiError)
  })
})

describe('gdrive duplicate sibling names', () => {
  it('ranks newest modifiedTime first, breaking ties by the greater id', () => {
    expect(
      ranksAbove(
        duplicateRank('2026-06-01T00:00:00Z', 'aaa'),
        duplicateRank('2026-01-01T00:00:00Z', 'zzz'),
      ),
    ).toBe(true)
    // The id is a tiebreak, never the primary key.
    expect(
      ranksAbove(
        duplicateRank('2026-06-01T00:00:00Z', 'bbb'),
        duplicateRank('2026-06-01T00:00:00Z', 'aaa'),
      ),
    ).toBe(true)
    expect(
      ranksAbove(
        duplicateRank('2026-01-01T00:00:00Z', 'zzz'),
        duplicateRank('2026-06-01T00:00:00Z', 'aaa'),
      ),
    ).toBe(false)
  })

  it('pickDuplicate takes the newest whatever order it was listed in', () => {
    const old = { id: 'id1', name: 'dup.txt', modifiedTime: '2026-01-01T00:00:00Z' }
    const fresh = { id: 'id2', name: 'dup.txt', modifiedTime: '2026-06-01T00:00:00Z' }
    expect(pickDuplicate([old, fresh])?.id).toBe('id2')
    expect(pickDuplicate([fresh, old])?.id).toBe('id2')
    expect(pickDuplicate([])).toBeUndefined()
  })

  it('pickDuplicate tolerates a missing modifiedTime', () => {
    const unstamped = { id: 'id1', name: 'dup.txt' }
    const stamped = { id: 'id2', name: 'dup.txt', modifiedTime: '2026-01-01T00:00:00Z' }
    expect(pickDuplicate([unstamped, stamped])?.id).toBe('id2')
  })

  it('resolveKey picks the newest of two same-named siblings, oldest listed first', async () => {
    // The fake answers in insertion order and honours no orderBy, which
    // is the point: the rule has to hold without the server sorting.
    fake.add('dup.txt', 'root', undefined, undefined, undefined, '2026-01-01T00:00:00Z')
    const newest = fake.add(
      'dup.txt',
      'root',
      undefined,
      undefined,
      undefined,
      '2026-06-01T00:00:00Z',
    )
    expect((await resolveKey(accessor, 'dup.txt'))?.id).toBe(newest)
  })

  it('resolveKey picks the newest of two same-named siblings, newest listed first', async () => {
    const newest = fake.add(
      'dup.txt',
      'root',
      undefined,
      undefined,
      undefined,
      '2026-06-01T00:00:00Z',
    )
    fake.add('dup.txt', 'root', undefined, undefined, undefined, '2026-01-01T00:00:00Z')
    expect((await resolveKey(accessor, 'dup.txt'))?.id).toBe(newest)
  })
})
