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
import { joinRoot } from './utils.ts'

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
