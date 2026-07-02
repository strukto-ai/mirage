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

import { mountKey, stripSlash } from '@struktoai/mirage-core'
import { describe, expect, it } from 'vitest'
import { PathSpec } from '@struktoai/mirage-core'
import { isDirectoryAttrs, isFileAttrs, isNoSuchFile, joinRoot, stripPrefix } from './utils.ts'

describe('stripPrefix', () => {
  it('removes the prefix from the original path', () => {
    const p = new PathSpec({
      virtual: '/ssh/foo/bar',
      directory: '/ssh/foo',
      resourcePath: mountKey('/ssh/foo/bar', '/ssh'),
    })
    expect(stripPrefix(p)).toBe('/foo/bar')
  })
  it('returns "/" when original equals the prefix', () => {
    const p = new PathSpec({
      virtual: '/ssh',
      directory: '/ssh',
      resourcePath: mountKey('/ssh', '/ssh'),
    })
    expect(stripPrefix(p)).toBe('/')
  })
  it('returns the original when the prefix does not match', () => {
    const p = new PathSpec({
      virtual: '/other/foo',
      directory: '/other',
      resourcePath: mountKey('/other/foo', '/ssh'),
    })
    expect(stripPrefix(p)).toBe('/other/foo')
  })
  it('returns the original when prefix is empty', () => {
    const p = new PathSpec({
      resourcePath: stripSlash('/foo/bar'),
      virtual: '/foo/bar',
      directory: '/foo',
    })
    expect(stripPrefix(p)).toBe('/foo/bar')
  })
})

describe('joinRoot', () => {
  it('joins root "/" with rel "/" -> "/"', () => {
    expect(joinRoot('/', '/')).toBe('/')
  })
  it('joins root "/" with rel "/foo" -> "/foo"', () => {
    expect(joinRoot('/', '/foo')).toBe('/foo')
  })
  it('joins root "/data" with rel "/" -> "/data"', () => {
    expect(joinRoot('/data', '/')).toBe('/data')
  })
  it('joins root "/data" with rel "/foo" -> "/data/foo"', () => {
    expect(joinRoot('/data', '/foo')).toBe('/data/foo')
  })
  it('joins root "/data" with rel "/foo/bar" -> "/data/foo/bar"', () => {
    expect(joinRoot('/data', '/foo/bar')).toBe('/data/foo/bar')
  })
  it('strips trailing slash from root: "/data/" + "/" -> "/data"', () => {
    expect(joinRoot('/data/', '/')).toBe('/data')
  })
  it('strips trailing slash from root: "/data/" + "/foo" -> "/data/foo"', () => {
    expect(joinRoot('/data/', '/foo')).toBe('/data/foo')
  })
})

describe('isNoSuchFile', () => {
  it('returns true for { code: 2 }', () => {
    expect(isNoSuchFile({ code: 2 })).toBe(true)
  })
  it('returns false for { code: 4 }', () => {
    expect(isNoSuchFile({ code: 4 })).toBe(false)
  })
  it('returns false for null', () => {
    expect(isNoSuchFile(null)).toBe(false)
  })
  it('returns false for undefined', () => {
    expect(isNoSuchFile(undefined)).toBe(false)
  })
  it('returns false for a plain Error without code', () => {
    expect(isNoSuchFile(new Error('x'))).toBe(false)
  })
})

describe('isDirectoryAttrs', () => {
  it('returns true for a dir mode', () => {
    expect(isDirectoryAttrs({ mode: 0o040755 })).toBe(true)
  })
  it('returns false for a regular file mode', () => {
    expect(isDirectoryAttrs({ mode: 0o100644 })).toBe(false)
  })
  it('returns false when mode is missing', () => {
    expect(isDirectoryAttrs({})).toBe(false)
  })
})

describe('isFileAttrs', () => {
  it('returns true for a regular file mode', () => {
    expect(isFileAttrs({ mode: 0o100644 })).toBe(true)
  })
  it('returns false for a dir mode', () => {
    expect(isFileAttrs({ mode: 0o040755 })).toBe(false)
  })
  it('returns false when mode is missing', () => {
    expect(isFileAttrs({})).toBe(false)
  })
})
