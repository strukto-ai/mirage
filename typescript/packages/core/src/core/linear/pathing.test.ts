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
  cycleFilename,
  documentFilename,
  issueDirname,
  memberFilename,
  projectFilename,
  sanitizeName,
  teamDirname,
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
})

describe('dirnames and filenames', () => {
  it('builds team dirname with key + name', () => {
    expect(teamDirname({ id: 't1', key: 'ENG', name: 'Engineering' })).toBe('ENG__Engineering__t1')
  })
  it('builds team dirname with just key when name absent', () => {
    expect(teamDirname({ id: 't1', key: 'ENG' })).toBe('ENG__t1')
  })
  it('builds team dirname collapses dup', () => {
    expect(teamDirname({ id: 't1', key: 'ENG', name: 'ENG' })).toBe('ENG__t1')
  })
  it('builds member filename from displayName', () => {
    expect(memberFilename({ id: 'u1', displayName: 'Alice', name: 'Alice C' })).toBe(
      'Alice__u1.json',
    )
  })
  it('builds member filename falls back to email', () => {
    expect(memberFilename({ id: 'u1', email: 'alice@example.com' })).toBe(
      'alice_example.com__u1.json',
    )
  })
  it('builds issue dirname from identifier', () => {
    expect(issueDirname({ id: 'i1', identifier: 'STR-42' })).toBe('STR-42__i1')
  })
  it('builds project filename', () => {
    expect(projectFilename({ id: 'p1', name: 'Q1 Roadmap' })).toBe('Q1_Roadmap__p1.json')
  })
  it('builds cycle filename', () => {
    expect(cycleFilename({ id: 'c1', name: 'Sprint 12' })).toBe('Sprint_12__c1.json')
  })
})

const CJK = '会議の記録'.repeat(40)
const UUID = '3fa85f64-5717-4562-b3fc-2c963f66afa6'

describe('linear names fit NAME_MAX', () => {
  // These composed `<label>__<id>` by hand, so the 100-character cap in
  // sanitizeName let a CJK name render 338-343 bytes against a 255-byte
  // NAME_MAX. They route through fitIdName now.
  const cases: [string, (v: string, i: string) => string, string][] = [
    ['teamDirname', (v, i) => teamDirname({ key: v, name: v, id: i }), ''],
    ['memberFilename', (v, i) => memberFilename({ displayName: v, id: i }), '.json'],
    ['issueDirname', (v, i) => issueDirname({ identifier: v, id: i }), ''],
    ['projectFilename', (v, i) => projectFilename({ name: v, id: i }), '.json'],
    ['cycleFilename', (v, i) => cycleFilename({ name: v, id: i }), '.json'],
    ['documentFilename', (v, i) => documentFilename({ title: v, id: i }), '.json'],
  ]
  it.each(cases)('%s fits and still addresses the id', (_name, build, suffix) => {
    const name = build(CJK, UUID)
    expect(byteLength(name)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(name).not.toContain('\uFFFD')
    expect(parseIdName(name, suffix)[1]).toBe(UUID)
  })

  it('keeps the separator between teamDirname parts', () => {
    // The label is two sanitized parts joined by `__`; re-sanitizing it would
    // collapse that to `_` and change the directory's name.
    expect(teamDirname({ key: 'ENG', name: 'Engineering', id: 'T1' })).toBe('ENG__Engineering__T1')
  })
})
