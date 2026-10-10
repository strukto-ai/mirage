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
import {
  boardDirname,
  cardDirname,
  labelFilename,
  listDirname,
  memberFilename,
  sanitizeName,
  workspaceDirname,
} from './pathing.ts'
import { parseIdName } from '../../utils/naming.ts'
import { NAME_MAX_BYTES, byteLength } from '../../utils/sanitize.ts'

describe('sanitizeName', () => {
  it('replaces unsafe chars and collapses underscores', () => {
    expect(sanitizeName('Hello / World')).toBe('Hello_World')
  })
  it('returns "unknown" for empty', () => {
    expect(sanitizeName('   ')).toBe('unknown')
  })
  it('truncates long names', () => {
    expect(sanitizeName('a'.repeat(200))).toHaveLength(100)
  })
})

describe('dirnames and filenames', () => {
  it('builds workspace dirname from displayName', () => {
    expect(workspaceDirname({ id: 'w1', displayName: 'My Team' })).toBe('My_Team__w1')
  })
  it('falls back to name when displayName is missing', () => {
    expect(workspaceDirname({ id: 'w2', name: 'fallback' })).toBe('fallback__w2')
  })
  it('builds board dirname', () => {
    expect(boardDirname({ id: 'b1', name: 'Roadmap' })).toBe('Roadmap__b1')
  })
  it('builds list dirname', () => {
    expect(listDirname({ id: 'l1', name: 'Doing' })).toBe('Doing__l1')
  })
  it('builds card dirname', () => {
    expect(cardDirname({ id: 'c1', name: 'fix bug' })).toBe('fix_bug__c1')
  })
  it('builds member filename from fullName', () => {
    expect(memberFilename({ id: 'm1', fullName: 'Alice Cooper' })).toBe('Alice_Cooper__m1.json')
  })
  it('builds member filename from username', () => {
    expect(memberFilename({ id: 'm2', username: 'bob' })).toBe('bob__m2.json')
  })
  it('builds label filename from name', () => {
    expect(labelFilename({ id: 'L1', name: 'urgent' })).toBe('urgent__L1.json')
  })
  it('builds label filename from color when name missing', () => {
    expect(labelFilename({ id: 'L2', color: 'red' })).toBe('red__L2.json')
  })
})

const CJK = '会議の記録'.repeat(40)
const HEX24 = '5f2a9b1c3d4e5f6a7b8c9d0e'

describe('trello names fit NAME_MAX', () => {
  // These composed `<label>__<id>` by hand, so the 100-character cap in
  // sanitizeName let a CJK name render 326-331 bytes against a 255-byte
  // NAME_MAX. They route through fitIdName now.
  const cases: [string, (v: string, i: string) => string, string][] = [
    ['workspaceDirname', (v, i) => workspaceDirname({ displayName: v, id: i }), ''],
    ['boardDirname', (v, i) => boardDirname({ name: v, id: i }), ''],
    ['listDirname', (v, i) => listDirname({ name: v, id: i }), ''],
    ['cardDirname', (v, i) => cardDirname({ name: v, id: i }), ''],
    ['memberFilename', (v, i) => memberFilename({ fullName: v, id: i }), '.json'],
    ['labelFilename', (v, i) => labelFilename({ name: v, id: i }), '.json'],
  ]
  it.each(cases)('%s fits and still addresses the id', (_name, build, suffix) => {
    const name = build(CJK, HEX24)
    expect(byteLength(name)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(name).not.toContain('\uFFFD')
    expect(parseIdName(name, suffix)[1]).toBe(HEX24)
  })
})
