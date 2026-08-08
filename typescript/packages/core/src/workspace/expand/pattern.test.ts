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
import { getCaseItems } from '../../shell/helpers.ts'
import { fnmatch } from '../../utils/fnmatch.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Session } from '../session/session.ts'
import type { ExecuteFn } from './node.ts'
import { escapeGlob } from '../../utils/glob_walk.ts'
import { expandPattern } from './pattern.ts'
import type { TSNodeLike } from '../../shell/types.ts'

const failExec: ExecuteFn = () =>
  Promise.reject(new Error('pattern expansion must not run commands here'))

async function expand(snippet: string, env: Record<string, string> = {}): Promise<string> {
  const parser = await getTestParser()
  const root = parser.parse(`case x in ${snippet}) :;; esac`) as unknown as TSNodeLike
  const caseNode = root.children[0]
  if (caseNode === undefined) throw new Error('no case statement parsed')
  const [item] = getCaseItems(caseNode)
  const patterns = item?.[0] ?? []
  expect(patterns).toHaveLength(1)
  const pattern = patterns[0]
  if (pattern === undefined) throw new Error('no pattern parsed')
  const session = new Session({ sessionId: 'test', env })
  return expandPattern(pattern, session, failExec)
}

describe('escapeGlob', () => {
  it.each([
    ['plain', 'plain'],
    ['a*b', 'a[*]b'],
    ['?x[', '[?]x[[]'],
    [']', ']'],
  ])('encodes %j as %j', (text, expected) => {
    expect(escapeGlob(text)).toBe(expected)
  })

  it('matches itself and nothing else', () => {
    expect(fnmatch('a*b', escapeGlob('a*b'))).toBe(true)
    expect(fnmatch('aXb', escapeGlob('a*b'))).toBe(false)
    expect(fnmatch('[^a]', escapeGlob('[^a]'))).toBe(true)
    expect(fnmatch('b', escapeGlob('[^a]'))).toBe(false)
  })
})

describe('expandPattern', () => {
  it('keeps a single-quoted pattern literal', async () => {
    expect(await expand("'*'")).toBe('[*]')
  })

  it('keeps a double-quoted pattern literal', async () => {
    expect(await expand('"*"')).toBe('[*]')
  })

  it('keeps globs live in an unquoted word', async () => {
    expect(await expand('*')).toBe('*')
  })

  it('escapes the value of a quoted expansion', async () => {
    expect(await expand('"$x"', { x: '*' })).toBe('[*]')
  })

  it('keeps an unquoted expansion a live pattern', async () => {
    expect(await expand('$x', { x: '*' })).toBe('*')
  })

  it('honours backslash escapes in an unquoted word', async () => {
    expect(await expand('a\\*b')).toBe('a[*]b')
    expect(await expand('\\?')).toBe('[?]')
  })

  it('decodes then escapes an ANSI-C pattern', async () => {
    expect(await expand("$'a\\t*'")).toBe('a\t[*]')
  })

  it('treats a translated string pattern as literal', async () => {
    expect(await expand('$"a?"')).toBe('a[?]')
  })

  it('mixes literal and live segments in a concatenation', async () => {
    expect(await expand("'a'*")).toBe('a*')
    expect(await expand('\'*\'"?"')).toBe('[*][?]')
  })

  it('expands a leading tilde in an unquoted pattern', async () => {
    expect(await expand('~/x', { HOME: '/home/u' })).toBe('/home/u/x')
  })

  it('keeps an escaped tilde literal', async () => {
    expect(await expand('\\~', { HOME: '/home/u' })).toBe('~')
  })
})
