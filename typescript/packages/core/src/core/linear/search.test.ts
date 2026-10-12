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
import { LinearAccessor } from '../../accessor/linear.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { LinearTransport } from './client.ts'
import { unsearchedText } from './normalize.ts'
import { SEARCH_LIMIT, filesContaining } from './search.ts'

const TEAM = { id: 'T1', key: 'ENG', name: 'Engineering' }

function issue(
  id: string,
  title: string,
  state: string,
  description = '',
): Record<string, unknown> {
  return {
    id,
    identifier: `ENG-${id.slice(-1)}`,
    title,
    description,
    team: TEAM,
    state: { id: 'S', name: state },
  }
}

const ISSUES = [
  issue('I1', 'Fix the login page', 'Todo'),
  issue('I2', 'Write release notes', 'Blocked'),
  issue('I3', 'Docs', 'Todo', 'Visit wombat.example.com first'),
]

// Answers the team listing, the issue listing and the issue search, recording
// each searched term.
class FakeTransport implements LinearTransport {
  readonly searched: string[] = []
  constructor(
    private readonly named: string[] | Record<string, string[]>,
    private readonly reply?: Record<string, unknown> | Error,
  ) {}
  graphql(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const page = { hasNextPage: false, endCursor: null }
    if (query.includes('searchIssues')) {
      this.searched.push(String(variables.term))
      if (this.reply instanceof Error) return Promise.reject(this.reply)
      if (this.reply !== undefined) return Promise.resolve(this.reply)
      const ids = Array.isArray(this.named)
        ? this.named
        : (this.named[String(variables.term)] ?? [])
      return Promise.resolve({ searchIssues: { nodes: ids.map((id) => ({ id })) } })
    }
    if (query.includes('issues(')) {
      return Promise.resolve({ team: { issues: { nodes: ISSUES, pageInfo: page } } })
    }
    return Promise.resolve({ teams: { nodes: [TEAM], pageInfo: page } })
  }
}

function scope(vfsPath = ''): PathSpec {
  const virtual = vfsPath === '' ? '/linear' : `/linear/${vfsPath}`
  return new PathSpec({ virtual, directory: virtual, vfsPath })
}

async function ask(
  text: string,
  named: string[] | Record<string, string[]>,
  under = scope(),
  reply?: Record<string, unknown> | Error,
): Promise<[PathSpec[] | null, string[]]> {
  const transport = new FakeTransport(named, reply)
  const out = await filesContaining(
    new LinearAccessor(transport, { contentSearch: true }),
    text,
    [under],
    new RAMIndexCacheStore(),
  )
  return [out, transport.searched]
}

// Twin of python/tests/core/linear/test_search.py.
describe('linear filesContaining', () => {
  it('leaves the title and description out of the unsearched text', () => {
    const kept = unsearchedText(ISSUES[0] ?? {})
    expect(kept).toContain('todo')
    expect(kept).toContain('engineering')
    expect(kept).not.toContain('login')
  })

  // Linear names the issue whose title holds the word; the other is named by
  // its state, which Linear's search does not read.
  it('answers what Linear names and what the listing kept', async () => {
    const [out, searched] = await ask('Blocked', ['I1'])
    expect(out?.map((p) => p.vfsPath.split('/').at(-2)).sort()).toEqual(['ENG-1__I1', 'ENG-2__I2'])
    expect(out?.every((p) => p.vfsPath.endsWith('/issue.json'))).toBe(true)
    expect(searched).toEqual(['blocked', 'locked'])
  })

  // Linear's search may miss a word inside a link, so the listing keeps it,
  // and each word of a phrase is found in either place.
  it('keeps a word inside a link in the listing', async () => {
    const [out, searched] = await ask('visit wombat', { visit: ['I3'] })
    expect(out?.map((p) => p.vfsPath.split('/').at(-2))).toEqual(['ENG-3__I3'])
    expect(searched).toEqual(['visit', 'wombat'])
  })

  it.each<[string, string[], string]>([
    ['title', ['I1'], ''],
    ['true', ['I1'], ''],
    ['q4', ['I1'], ''],
    ['login', [], ''],
    ['login', Array.from({ length: SEARCH_LIMIT }, (_, i) => `X${String(i)}`), ''],
    ['login', ['I1'], 'teams/ENG__Engineering__T1/issues/ENG-1__I1'],
  ])('reads every file for %j when unsure', async (text, named, under) => {
    const [out] = await ask(text, named, scope(under))
    expect(out).toBeNull()
  })

  // A reply that is not a list of issues, or not JSON, is a failed search:
  // I2's state holds "Blocked", but Linear may have named I1 too.
  it.each<[Record<string, unknown> | Error]>([
    [{ searchIssues: { nodes: {} } }],
    [{ searchIssues: null }],
    [{ searchIssues: { nodes: [{ title: 'Fix the login page' }] } }],
    [new SyntaxError('Unexpected token < in JSON')],
  ])('reads every file for the garbled reply %#', async (reply) => {
    const [out] = await ask('Blocked', [], scope(), reply)
    expect(out).toBeNull()
  })
})
