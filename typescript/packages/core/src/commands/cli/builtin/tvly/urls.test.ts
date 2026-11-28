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
import { hostOf, hostnameOf, pageSlug, parseUrl } from './urls.ts'

// Mirrors python's tests/commands/cli/builtin/tvly/test_urls.py.
describe('tvly urls', () => {
  it('splits a url into the parts tvly reads', () => {
    const parsed = parseUrl('HTTPS://Docs.Example.com:8443/a b?q=1#top')
    expect(parsed).not.toBeNull()
    expect(parsed?.hostname).toBe('docs.example.com')
    expect(parsed?.host).toBe('docs.example.com:8443')
    expect(parsed?.pathname).toBe('/a%20b')
    expect(parsed?.search).toBe('?q=1')
  })

  it('drops the default port from the host', () => {
    expect(hostOf('https://example.com:443/x')).toBe('example.com')
    expect(hostOf('http://example.com:80')).toBe('example.com')
  })

  it('keeps the fallbacks of text that is no url', () => {
    expect(parseUrl('not a url')).toBeNull()
    expect(hostnameOf('not a url')).toBe('')
    expect(hostOf('not a url')).toBe('not a url')
  })

  it.each([
    ['https://docs.example.com/guide/intro/', 'docs.example.com_guide_intro'],
    ['https://example.com/', 'example.com'],
    ['https://example.com/a?x=1', 'example.com_a_x_1'],
    ['///', 'index'],
    ['https://example.com/a/../b', 'example.com_b'],
    ['https://example.com/a/./b/%2E', 'example.com_a_b'],
    ['https://example.com/a/b/..', 'example.com_a'],
    ['https://example.com/../..', 'example.com'],
  ])('slugs %s as %s', (url, slug) => {
    expect(pageSlug(url)).toBe(slug)
  })
})
