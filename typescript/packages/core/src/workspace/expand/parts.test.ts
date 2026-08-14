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
import { IOResult } from '../../io/types.ts'
import { getParts } from '../../shell/helpers.ts'
import { globPattern, unmarkGlobs } from '../../utils/glob_walk.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Session } from '../session/session.ts'
import { expandParts, expandWords } from './parts.ts'
import type { ExecuteFn } from './node.ts'

const ENC = new TextEncoder()

async function words(cmd: string, env: Record<string, string> = {}, stdout = '') {
  const parser = await getTestParser()
  const root = parser.parse(cmd)
  const parts = getParts(root.namedChildren[0] as never)
  const session = new Session({ sessionId: 't', cwd: '/', env })
  const executeFn: ExecuteFn = () => Promise.resolve(new IOResult({ stdout: ENC.encode(stdout) }))
  return { parts, session, executeFn, out: await expandWords(parts, session, executeFn) }
}

// One word's literal spelling and the pattern a matcher would see.
async function read(cmd: string, env: Record<string, string> = {}): Promise<[string, string]> {
  const { out } = await words(cmd, env)
  const w = out[1] ?? ''
  return [unmarkGlobs(w), globPattern(w)]
}

// `pattern` is what fnmatch is handed: a live metacharacter stays bare,
// one that quoting made literal arrives as its own character class.
describe('expandWords quoting', () => {
  it.each([
    ['c /data/*.txt', '/data/*.txt', '/data/*.txt'],
    ["c '/data/*.txt'", '/data/*.txt', '/data/[*].txt'],
    ['c "/data/*.txt"', '/data/*.txt', '/data/[*].txt'],
    ['c /data/\\*.txt', '/data/*.txt', '/data/[*].txt'],
    ["c '/data/?.txt'", '/data/?.txt', '/data/[?].txt'],
    ["c '/data/[a].txt'", '/data/[a].txt', '/data/[[]a].txt'],
    ["c $'/data/*.txt'", '/data/*.txt', '/data/[*].txt'],
    ['c /data/a.txt', '/data/a.txt', '/data/a.txt'],
  ] as [string, string, string][])('%s', async (cmd, literal, pattern) => {
    expect(await read(cmd)).toEqual([literal, pattern])
  })

  // The heart of it: quoting is per character, so one word can carry both
  // a live metacharacter and a quoted one (GNU bash 5.2.37, pinned).
  it.each([
    ['c "/data/"*.txt', '/data/*.txt', '/data/*.txt'],
    ["c '/data/*'.txt", '/data/*.txt', '/data/[*].txt'],
    ["c '/data/'x\\*.txt", '/data/x*.txt', '/data/x[*].txt'],
    ['c "/data/*"?.txt', '/data/*?.txt', '/data/[*]?.txt'],
    ["c '/data/*'?.txt", '/data/*?.txt', '/data/[*]?.txt'],
    ["c '/data/*'*.txt", '/data/**.txt', '/data/[*]*.txt'],
    ["c /data/*'?'.txt", '/data/*?.txt', '/data/*[?].txt'],
  ] as [string, string, string][])('%s', async (cmd, literal, pattern) => {
    expect(await read(cmd)).toEqual([literal, pattern])
  })

  it('keeps an unquoted expansion value live', async () => {
    expect(await read('c $p', { p: '/data/*.txt' })).toEqual(['/data/*.txt', '/data/*.txt'])
  })

  it('makes a quoted expansion value literal', async () => {
    expect(await read('c "$p"', { p: '/data/*.txt' })).toEqual(['/data/*.txt', '/data/[*].txt'])
  })

  it('mixes a quoted expansion with a live metacharacter', async () => {
    // bash: `"$p"?.txt` with p='*' globs on the `?` alone.
    expect(await read('c "$p"?.txt', { p: '*' })).toEqual(['*?.txt', '[*]?.txt'])
  })

  it('keeps command substitution words live', async () => {
    const { out } = await words('c $(inner)', {}, '*.txt plain')
    expect(out.slice(1).map((w) => globPattern(w))).toEqual(['*.txt', 'plain'])
  })

  it('keeps a quoted brace alternative literal', async () => {
    const { out } = await words("c {'*',x}")
    expect(out.slice(1).map((w) => [unmarkGlobs(w), globPattern(w)])).toEqual([
      ['*', '[*]'],
      ['x', 'x'],
    ])
  })

  it('keeps a brace template glob live', async () => {
    const { out } = await words('c {a,b}*')
    expect(out.slice(1).map((w) => globPattern(w))).toEqual(['a*', 'b*'])
  })

  it('keeps an escaped brace template glob literal', async () => {
    const { out } = await words('c {a,b}.\\*')
    expect(out.slice(1).map((w) => [unmarkGlobs(w), globPattern(w)])).toEqual([
      ['a.*', 'a.[*]'],
      ['b.*', 'b.[*]'],
    ])
  })

  it('keeps an unquoted brace atom live', async () => {
    const { out } = await words('c {$p,x}', { p: '*.txt' })
    expect(out.slice(1).map((w) => globPattern(w))).toEqual(['*.txt', 'x'])
  })
})

describe('expandParts', () => {
  it('is the unmarked view of expandWords', async () => {
    const cmd = "c '/data/*.txt' \"/data/\"*.txt {a,b}* '/data/*'?.txt"
    const { parts, session, executeFn, out } = await words(cmd)
    const texts = await expandParts(parts, session, executeFn)
    expect(texts).toEqual(out.map((w) => unmarkGlobs(w)))
    // No mark ever reaches a caller of expandParts.
    expect(texts.every((t) => t === unmarkGlobs(t))).toBe(true)
  })
})
