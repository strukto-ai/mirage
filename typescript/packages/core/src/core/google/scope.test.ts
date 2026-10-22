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
import { appFilename, appScopes } from './scope.ts'
import { Codec } from '../hierarchy/codec.ts'
import { matchScope } from '../hierarchy/scope.ts'
import { NAME_MAX_BYTES, byteLength } from '../../utils/sanitize.ts'

const SUFFIX = '.gdoc.json'
// A real Google file id is 44 characters, so this is the fixed overhead a
// title actually has to fit inside.
const DOC_ID = '1'.repeat(44)

describe('appFilename', () => {
  it('leads with the date when there is one', () => {
    expect(appFilename('My Document', 'abc123', '2026-03-15T10:00:00Z', SUFFIX)).toBe(
      '2026-03-15_My_Document__abc123.gdoc.json',
    )
    expect(appFilename('My Document', 'abc123', '', SUFFIX)).toBe('My_Document__abc123.gdoc.json')
  })

  it('fits NAME_MAX for a CJK title', () => {
    // 100 characters of CJK is 300 bytes, which the character budget passed
    // untouched: with the date, the id and the suffix the name came to 367
    // bytes and ext4/APFS reject it with ENAMETOOLONG.
    const name = appFilename('会議の記録'.repeat(40), DOC_ID, '2026-08-20T12:00:00Z', SUFFIX)
    expect(byteLength(name)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(name.startsWith('2026-08-20_')).toBe(true)
    expect(name.endsWith(`__${DOC_ID}.gdoc.json`)).toBe(true)
    // The cut lands on a character boundary, never mid-sequence.
    expect(name).not.toContain('\uFFFD')
  })

  it('leaves an ascii title on the character budget', () => {
    const name = appFilename('a'.repeat(400), DOC_ID, '', SUFFIX)
    expect(byteLength(name)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(name).toBe(`${'a'.repeat(97)}...__${DOC_ID}.gdoc.json`)
  })

  it('keeps the id when it leaves no room', () => {
    // The title is what gives, never the id: a trimmed id would stop
    // addressing the file. Same rule as gcal's event filenames.
    const longId = 'v'.repeat(NAME_MAX_BYTES - 4)
    expect(appFilename('Some Title', longId, '', SUFFIX)).toContain(`__${longId}.gdoc.json`)
  })
})

describe('appScopes', () => {
  const scopes = appScopes(new Codec({ suffix: '.gslide.json' }))

  it('keeps a Drive id that holds the separator whole', () => {
    // Drive ids are [A-Za-z0-9_-], so `__` turns up inside one now and then
    // (a real deck's, below); the title never holds one, since sanitizing
    // collapses every run of underscores. Split on the last `__`, this name
    // read `OWES6...` as the id and the deck answered ENOENT.
    const id = '1D2dqZx96t_aSHk3kLorY__OWES6DAtwNTt1_NMMVLjM'
    const name = appFilename('MIRAGE Slides Test', id, '2026-04-04T00:00:00Z', '.gslide.json')
    expect(matchScope(scopes, ['owned', name])?.[1]).toEqual({
      corpus: 'owned',
      name: '2026-04-04_MIRAGE_Slides_Test',
      file_id: id,
    })
  })

  it('keeps an id that starts with an underscore whole', () => {
    const name = appFilename('Deck_', '_abc', '', '.gslide.json')
    expect(matchScope(scopes, ['shared', name])?.[1]).toMatchObject({ file_id: '_abc' })
  })
})
