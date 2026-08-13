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
import { pathHidden, varHidden } from './hidden.ts'

describe('pathHidden', () => {
  it('null and empty specs hide nothing', () => {
    expect(pathHidden(null, '/a/b')).toBe(false)
    expect(pathHidden({}, '/a/b')).toBe(false)
  })

  it('an exact path hides itself and its subtree', () => {
    // A name you cannot see cannot be a parent you traverse, so hiding
    // a path always hides everything under it.
    const h = { paths: ['/s3/secrets'] }
    expect(pathHidden(h, '/s3/secrets')).toBe(true)
    expect(pathHidden(h, '/s3/secrets/a.txt')).toBe(true)
    expect(pathHidden(h, '/s3/secrets/deep/b')).toBe(true)
    expect(pathHidden(h, '/s3')).toBe(false)
    expect(pathHidden(h, '/s3/secretsfoo')).toBe(false)
  })

  it('exact path spellings are normalized', () => {
    expect(pathHidden({ paths: ['/s3/secrets/'] }, '/s3/secrets')).toBe(true)
    expect(pathHidden({ paths: ['s3/secrets'] }, '/s3/secrets/a')).toBe(true)
  })

  it('an exact path at a mount root covers the mount', () => {
    const h = { paths: ['/s3'] }
    expect(pathHidden(h, '/s3/any/depth')).toBe(true)
    expect(pathHidden(h, '/other')).toBe(false)
  })

  it('a component pattern applies inside every mount', () => {
    const h = { patterns: ['*.key'] }
    expect(pathHidden(h, '/a/b.key')).toBe(true)
    expect(pathHidden(h, '/other/deep/c.key')).toBe(true)
    expect(pathHidden(h, '/a/b.key/inside.txt')).toBe(true)
    expect(pathHidden(h, '/a/bkey')).toBe(false)
    expect(pathHidden(h, '/a/keyed')).toBe(false)
  })

  it('an anchored pattern matches the full virtual path', () => {
    const h = { patterns: ['/config/*.pem'] }
    expect(pathHidden(h, '/config/x.pem')).toBe(true)
    expect(pathHidden(h, '/config/x.pem/sub')).toBe(true)
    expect(pathHidden(h, '/other/x.pem')).toBe(false)
  })

  it('anchored star crosses slashes like find -path', () => {
    expect(pathHidden({ patterns: ['/config/*.pem'] }, '/config/nested/x.pem')).toBe(true)
  })

  it('patterns share the repo fnmatch dialect', () => {
    // [^...] negates like [!...] (bash/glibc).
    const h = { patterns: ['[^a]*.key'] }
    expect(pathHidden(h, '/x/b.key')).toBe(true)
    expect(pathHidden(h, '/x/a.key')).toBe(false)
  })
})

describe('varHidden', () => {
  it('null hides nothing', () => {
    expect(varHidden(null, 'SECRET')).toBe(false)
  })

  it('names are exact', () => {
    const h = { names: ['SLACK_TOKEN'] }
    expect(varHidden(h, 'SLACK_TOKEN')).toBe(true)
    expect(varHidden(h, 'SLACK_TOKEN2')).toBe(false)
  })

  it('patterns are globs over names', () => {
    const h = { patterns: ['AWS_*', '*_SECRET'] }
    expect(varHidden(h, 'AWS_ACCESS_KEY_ID')).toBe(true)
    expect(varHidden(h, 'DB_SECRET')).toBe(true)
    expect(varHidden(h, 'HOME')).toBe(false)
  })
})
