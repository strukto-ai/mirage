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

import { describe, expect, it, vi } from 'vitest'
import { LinearAccessor } from '../../accessor/linear.ts'
import { PathSpec } from '../../types.ts'
import type { LinearTransport } from './client.ts'
import { unsearchedText } from './normalize.ts'
import { SEARCH_LIMIT, filesContaining } from './search.ts'

const TEAM = { id: 'T1', key: 'ENG', name: 'Engineering' }
const ISSUES_DIR = 'teams/ENG__Engineering__T1/issues'
const DOCS_DIR = 'teams/ENG__Engineering__T1/documents'

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
const DOCUMENTS = [
  { id: 'D1', title: 'Search plan', content: 'Wombat rollout steps' },
  { id: 'D2', title: 'Runbook', content: 'Restart the workers' },
]
const ALL_ISSUES = ['ENG-1__I1', 'ENG-2__I2', 'ENG-3__I3']

function connection(nodes: unknown[]): Record<string, unknown> {
  return { nodes, pageInfo: { hasNextPage: false, endCursor: null } }
}

// Answers the listings the walk reaches and the issue search by operation,
// recording each searched term.
class FakeTransport implements LinearTransport {
  readonly searched: string[] = []
  issues: Record<string, unknown>[] = ISSUES
  documents: Record<string, unknown>[] = DOCUMENTS
  constructor(
    private readonly named: string[] | Record<string, string[]>,
    private readonly reply?: Record<string, unknown> | Error,
  ) {}
  graphql(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? ''
    if (op === 'IssueSearch') {
      this.searched.push(String(variables.term))
      if (this.reply instanceof Error) return Promise.reject(this.reply)
      if (this.reply !== undefined) return Promise.resolve(this.reply)
      const ids = Array.isArray(this.named)
        ? this.named
        : (this.named[String(variables.term)] ?? [])
      return Promise.resolve({ searchIssues: { nodes: ids.map((id) => ({ id })) } })
    }
    if (op === 'TeamIssues') return Promise.resolve({ team: { issues: connection(this.issues) } })
    if (op === 'TeamDocuments') return Promise.resolve({ documents: connection(this.documents) })
    if (op === 'TeamMembers') return Promise.resolve({ team: { members: connection([]) } })
    if (op === 'TeamProjects') return Promise.resolve({ team: { projects: connection([]) } })
    if (op === 'TeamCycles') return Promise.resolve({ team: { cycles: connection([]) } })
    return Promise.resolve({ teams: connection([TEAM]) })
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
  askLinear = true,
): Promise<[PathSpec[] | null, string[]]> {
  const transport = new FakeTransport(named, reply)
  const out = await filesContaining(new LinearAccessor(transport), text, [under], askLinear)
  return [out, transport.searched]
}

function issues(out: PathSpec[] | null): string[] {
  return (out ?? [])
    .filter((p) => p.vfsPath.endsWith('/issue.json'))
    .map((p) => p.vfsPath.split('/').at(-2) ?? '')
    .sort()
}

function documents(out: PathSpec[] | null): string[] {
  return (out ?? []).filter((p) => p.vfsPath.startsWith(DOCS_DIR)).map((p) => p.vfsPath)
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
    expect(issues(out)).toEqual(['ENG-1__I1', 'ENG-2__I2'])
    expect(searched).toEqual(['blocked', 'locked'])
  })

  // Linear's search may miss a word inside a link, so the listing keeps it,
  // and each word of a phrase is found in either place.
  it('keeps a word inside a link in the listing', async () => {
    const [out, searched] = await ask('visit wombat', { visit: ['I3'] })
    expect(issues(out)).toEqual(['ENG-3__I3'])
    expect(searched).toEqual(['visit', 'wombat'])
  })

  // A document's listing entry keeps its text, so a document is read only
  // when that text holds the word in any case, whether Linear is asked or not.
  it.each([true, false])(
    'reads a document whose text holds it, askLinear %s',
    async (askLinear) => {
      const [out] = await ask('WOMBAT', ['I3'], scope(), undefined, askLinear)
      expect(documents(out)).toHaveLength(1)
      const [none] = await ask('nowhere', [], scope(DOCS_DIR))
      expect(none).toEqual([])
    },
  )

  // A read fetches the record as it is now, so the kept text is checked against
  // listings made for the search, not the ones the command walked; an issue
  // gone since is not read.
  it('finds a text changed since the listing', async () => {
    const transport = new FakeTransport({ numbat: ['I1'] })
    const accessor = new LinearAccessor(transport)
    const search = () => filesContaining(accessor, 'numbat', [scope()], true)
    await search()
    const changed = issue('I2', 'Write release notes', 'Blocked', 'See numbat.io')
    transport.issues = ISSUES.map((item) => (item.id === 'I2' ? changed : item))
    transport.documents = DOCUMENTS.map((doc) =>
      doc.id === 'D2' ? { ...doc, content: 'Numbat' } : doc,
    )
    let out = await search()
    expect(issues(out)).toEqual(['ENG-1__I1', 'ENG-2__I2'])
    expect(documents(out).filter((path) => path.includes('D2'))).toHaveLength(1)
    transport.issues = ISSUES.slice(0, 1)
    transport.documents = DOCUMENTS
    out = await search()
    expect(issues(out)).toEqual(['ENG-1__I1'])
  })

  // Without an answer from Linear every issue is read.
  it.each<[string, string[], boolean]>([
    ['title', ['I1'], true],
    ['true', ['I1'], true],
    ['q4', ['I1'], true],
    ['login', [], true],
    ['login', Array.from({ length: SEARCH_LIMIT }, (_, i) => `X${String(i)}`), true],
    ['login', ['I1'], false],
  ])('reads every issue for %j when unsure', async (text, named, askLinear) => {
    const [out] = await ask(text, named, scope(ISSUES_DIR), undefined, askLinear)
    expect(issues(out)).toEqual(ALL_ISSUES)
  })

  // A scope inside an issue and a text that is not ASCII read every file.
  it.each([
    ['login', `${ISSUES_DIR}/ENG-1__I1`],
    ['caf\u00e9', ''],
  ])('reads every file for %j under %j', async (text, under) => {
    const [out] = await ask(text, ['I1'], scope(under))
    expect(out).toBeNull()
  })

  // A reply that is not a list of issues, or not JSON, is a failed search:
  // I2's state holds "Blocked", but Linear may have named I1 too.
  it.each<[Record<string, unknown> | Error]>([
    [{ searchIssues: { nodes: {} } }],
    [{ searchIssues: null }],
    [{ searchIssues: { nodes: [{ title: 'Fix the login page' }] } }],
    [new SyntaxError('Unexpected token < in JSON')],
  ])('reads every issue for the garbled reply %#', async (reply) => {
    const warn = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      const [out] = await ask('Blocked', [], scope(ISSUES_DIR), reply)
      expect(issues(out)).toEqual(ALL_ISSUES)
    } finally {
      warn.mockRestore()
    }
  })
})
