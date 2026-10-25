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
import { FileStat, FileType, PathSpec, type DirListing } from '../../types.ts'
import { rowsOf } from '../hierarchy/probe.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import type { LinearTransport } from './client.ts'
import { readdir } from './readdir.ts'

function names(listed: readonly FileStat[] | DirListing): string[] {
  return rowsOf(listed).map((row) => row.name)
}

class NoopTransport implements LinearTransport {
  graphql(): Promise<Record<string, unknown>> {
    throw new Error('should not be called')
  }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, prefix) })
}

describe('linear readdir unrecognized paths', () => {
  it('throws ENOENT rather than reporting an empty directory', async () => {
    // Returning [] made `ls` and `tree` report a bogus path as real-but-empty,
    // and left `rg` without a message.
    await expect(
      readdir(new LinearAccessor(new NoopTransport()), spec('/__nf_missing__')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for an unrecognized nested path', async () => {
    await expect(
      readdir(new LinearAccessor(new NoopTransport()), spec('/teams/x/nope/deeper')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lists the virtual root without calling the api', async () => {
    const out = await readdir(new LinearAccessor(new NoopTransport()), spec('/'))
    expect(names(out)).toEqual(['teams'])
  })
})

// Twin of test_readdir_projects_asks_only_for_their_issues.
describe('linear readdir projects', () => {
  it('asks only for the issues of the projects it lists', async () => {
    const asked: Record<string, unknown>[] = []
    const transport: LinearTransport = {
      graphql: (query, variables) => {
        if (query.includes('teams(first')) {
          return Promise.resolve({
            teams: {
              nodes: [{ id: 'TEAM1', key: 'ENG', name: 'Engineering' }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          })
        }
        if (query.includes('projects(first')) {
          return Promise.resolve({
            team: {
              projects: {
                nodes: [
                  { id: 'P1', name: 'Alpha' },
                  { id: 'P2', name: 'Beta' },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          })
        }
        asked.push(variables ?? {})
        return Promise.resolve({
          team: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        })
      },
    }
    const out = await readdir(
      new LinearAccessor(transport),
      spec('/teams/ENG__Engineering__TEAM1/projects'),
      new FileStat({ name: 'projects', type: FileType.DIRECTORY }),
    )
    expect(names(out)).toHaveLength(2)
    expect(asked.map((variables) => variables.filter)).toEqual([
      { project: { id: { in: ['P1', 'P2'] } } },
    ])
  })
})
