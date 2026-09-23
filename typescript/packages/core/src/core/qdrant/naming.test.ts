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

import { resolveQdrantConfig } from '../../vfs/qdrant/config.ts'
import { byteLength, NAME_MAX_BYTES } from '../../utils/sanitize.ts'
import { PATH_SAFE } from '../hierarchy/codec.ts'
import { groupName, pointIdFromStem, rowStem } from './naming.ts'

describe('qdrant VFS naming', () => {
  it('renders a source URL as its basename', () => {
    expect(groupName('s3://docs/policies/refund-2026.pdf', true)).toBe('refund-2026.pdf')
  })

  it('renders group values through the shared path-safe codec', () => {
    // `/` renders as `∕` and a value already holding `∕` or `⁄` has that
    // character escaped, so `a/b` and `a∕b` cannot name one directory and
    // the scope table decodes each back to its own value. A basename leaf
    // renders the same way; only its parents are dropped.
    expect(groupName('a/b')).toBe('a∕b')
    expect(groupName('a∕b')).toBe('a⁄∕b')
    for (const raw of ['plain', 'a/b', 'a∕b', 'a⁄b']) {
      expect(PATH_SAFE.decode(groupName(raw))).toBe(raw)
    }
    expect(groupName('s3://x/y∕z.pdf', true)).toBe('y⁄∕z.pdf')
  })

  it('keeps the point id in a payload-derived filename', () => {
    const config = resolveQdrantConfig({ nameField: 'metadata.page' })
    const stem = rowStem({ id: 17, metadata: { page: '004' } }, config)
    expect(stem).toBe('004__17')
    expect(pointIdFromStem(stem, config)).toBe('17')
    expect(pointIdFromStem('18', config)).toBe('18')
  })

  it('reads a dotted id field as the literal synthetic key', () => {
    const config = resolveQdrantConfig({ idField: 'meta.id', nameField: 'title' })
    const stem = rowStem({ 'meta.id': 17, title: 'report' }, config)
    expect(stem).toBe('report__17')
    expect(pointIdFromStem(stem, config)).toBe('17')
  })

  it('reserves room for every enabled file suffix', () => {
    const config = resolveQdrantConfig({
      nameField: 'title',
      textField: 'text',
      blobField: 'blob',
      blobExt: 'very-long-extension',
    })
    const stem = rowStem({ id: 17, title: '界'.repeat(200) }, config)
    for (const suffix of ['.json', '.txt', '.very-long-extension']) {
      expect(byteLength(`${stem}${suffix}`)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    }
    expect(pointIdFromStem(stem, config)).toBe('17')
  })

  it('cuts a basename past NAME_MAX and keeps its identity', () => {
    // A leaf longer than NAME_MAX rendered whole, and ext4 and APFS refuse
    // such a name over a FUSE mount, so the rows under it could not be
    // opened. The segment is cut to fit and keeps the md5 of the whole leaf
    // as its id, the `<label>__<id>` shape every long name takes, so two
    // leaves that agree for 255 bytes stay two directories.
    const longA = groupName(`s3://docs/${'r'.repeat(300)}a.pdf`, true)
    const longB = groupName(`s3://docs/${'r'.repeat(300)}b.pdf`, true)
    expect(longA).toBe(`${'r'.repeat(221)}__ba0797292207781661c03dea74339808`)
    expect(longB).not.toBe(longA)
    const wide = groupName(`s3://docs/${'界'.repeat(100)}`, true)
    expect(byteLength(wide)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(wide).not.toContain('\uFFFD')
    expect(wide.endsWith('__51d13188e994b54376bb4693d036cf61')).toBe(true)
    expect(groupName(`s3://docs/${'r'.repeat(255)}`, true)).toBe('r'.repeat(255))
  })
})

describe('qdrant naming spells values as their JSON', () => {
  it('renders a non-string group value the way its .json spells it', () => {
    // Python's `str(True)` is `True` where `String(true)` is `true`, so one
    // collection would grow two different trees. A non-string value spells
    // the way the point's `.json` spells it.
    expect(groupName(true)).toBe('true')
    expect(groupName(1.0)).toBe('1')
    expect(groupName(7)).toBe('7')
    expect(groupName('True')).toBe('True')
  })

  it('keeps blank and dot-led group values addressable', () => {
    // A blank value used to render as `unknown` and a dot-led one as a
    // hidden segment; both carry the escape lead and decode back exactly.
    expect(groupName('')).toBe('⁄')
    expect(groupName('.env')).toBe('⁄.env')
    expect(groupName('s3://bucket/.env', true)).toBe('⁄.env')
    for (const raw of ['', '.env']) expect(PATH_SAFE.decode(groupName(raw))).toBe(raw)
  })

  it('spells a non-string label the way its .json spells it', () => {
    const config = resolveQdrantConfig({ nameField: 'flag' })
    expect(rowStem({ id: 17, flag: true }, config)).toBe('true__17')
    expect(rowStem({ id: 17, flag: 1.0 }, config)).toBe('1__17')
    expect(rowStem({ id: 17, flag: 1e-7 }, config)).toBe('1e-7__17')
    expect(rowStem({ id: 17, flag: { a: 1.0 } }, config)).toBe('{"a":1}__17')
  })

  it('keeps a dot-led label openable and a blank one readable', () => {
    // A leaf named `.env__17.json` is hidden from the listing and refused
    // as a path, so the label takes the escape lead. A blank label keeps
    // the readable `unknown` fallback: the id addresses.
    const config = resolveQdrantConfig({ nameField: 'title' })
    expect(rowStem({ id: 17, title: '.env' }, config)).toBe('⁄.env__17')
    expect(pointIdFromStem('⁄.env__17', config)).toBe('17')
    expect(rowStem({ id: 17, title: '' }, config)).toBe('unknown__17')
  })
})
