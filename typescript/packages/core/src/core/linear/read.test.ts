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
import { LinearVFS } from '../../vfs/linear/linear.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import type { LinearTransport } from './client.ts'

const TEAMS = [
  { id: 'TEAM1', key: 'ENG', name: 'Engineering' },
  { id: 'TEAM2', key: 'FIN', name: 'Finance' },
]

// Answers the teams listing and records every other query it is asked.
class TeamsTransport implements LinearTransport {
  readonly asked: string[] = []

  graphql(query: string): Promise<Record<string, unknown>> {
    if (query.includes('teams(first')) {
      return Promise.resolve({
        teams: { nodes: TEAMS, pageInfo: { hasNextPage: false, endCursor: null } },
      })
    }
    this.asked.push(query)
    return Promise.resolve({ issue: { id: 'ISSUE9' } })
  }
}

describe('linear read', () => {
  // The teams listing drops a team `teamIds` leaves out, and the issue read
  // used to fetch straight by the id in the path: `cat` served an issue of a
  // team `ls` and `stat` both reported absent.
  it('refuses a team outside teamIds on every surface', async () => {
    const transport = new TeamsTransport()
    const accessor = new LinearAccessor(transport, { teamIds: ['TEAM1'] })
    const vfs = Object.assign(new LinearVFS({ apiKey: 'lin_api_test' }), { accessor })
    const ws = new Workspace({ '/linear/': vfs })
    const secret = '/linear/teams/FIN__Finance__TEAM2'
    const issueJson = `${secret}/issues/FIN-9__ISSUE9/issue.json`
    for (const op of ['read', 'stat']) {
      await expect(ws.dispatch(op, issueJson)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await expect(ws.dispatch('readdir', secret)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(ws.dispatch('read', `${secret}/members/Eve__U9.json`)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(transport.asked).toEqual([])
  })
})
