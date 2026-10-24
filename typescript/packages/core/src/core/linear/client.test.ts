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
import { getIssue, listTeamIssues, type LinearTransport } from './client.ts'

class RecordingTransport implements LinearTransport {
  readonly queries = new Map<string, string>()

  graphql(query: string): Promise<Record<string, unknown>> {
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? ''
    this.queries.set(op, query)
    if (op === 'TeamIssues') {
      return Promise.resolve({
        team: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      })
    }
    return Promise.resolve({ issue: { id: 'I1' } })
  }
}

function selection(query: string, opener: string): string[] {
  const start = query.indexOf(opener) + opener.length
  let depth = 1
  for (let i = start; i < query.length; i += 1) {
    if (query[i] === '{') depth += 1
    else if (query[i] === '}') {
      depth -= 1
      if (depth === 0)
        return query
          .slice(start, i)
          .split(/\s+/)
          .filter((t) => t !== '')
    }
  }
  throw new Error(`${opener} is never closed`)
}

// Mirrors python's test_the_listing_and_the_read_select_the_same_issue_fields:
// issue.json is sized from the team listing (sizesAlwaysKnown) and read from
// the issue query, so a field one selects and the other does not makes the
// listed size disagree with the bytes a read delivers.
describe('linear issue queries', () => {
  it('the listing and the read select the same issue fields', async () => {
    const transport = new RecordingTransport()
    await listTeamIssues(transport, 'T1')
    await getIssue(transport, 'I1')
    const listed = selection(transport.queries.get('TeamIssues') ?? '', 'nodes {')
    const read = selection(transport.queries.get('Issue') ?? '', 'issue(id: $issueId) {')
    expect(listed).toContain('identifier')
    expect(listed).toEqual(read)
  })
})

// Twin of test_a_team_listing_pages_no_further_than_a_walks_limit.
it('pages a team listing no further than a walk limit', async () => {
  let asked = 0
  const transport: LinearTransport = {
    graphql: () => {
      asked += 1
      return Promise.resolve({
        team: {
          issues: {
            nodes: [{ id: `i${String(asked)}` }],
            pageInfo: { hasNextPage: true, endCursor: `c${String(asked)}` },
          },
        },
      })
    },
  }
  const issues = await listTeamIssues(transport, 'T1', 1)
  expect(issues.map((issue) => issue.id)).toEqual(['i1'])
  expect(asked).toBe(1)
})
