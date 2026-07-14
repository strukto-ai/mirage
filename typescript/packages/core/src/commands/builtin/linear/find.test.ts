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

import { LinearAccessor } from '../../../accessor/linear.ts'
import { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { LinearTransport } from '../../../core/linear/_client.ts'
import type { Resource } from '../../../resource/base.ts'
import { stripSlash } from '../../../utils/slash.ts'
import { LINEAR_COMMANDS } from './index.ts'

const DEC = new TextDecoder()

const TEAM = {
  id: 'TEAM1',
  key: 'ENG',
  name: 'Engineering',
  updatedAt: '2026-04-05T00:00:00Z',
  states: { nodes: [] },
}

const TEAM_DIR = '/teams/ENG__Engineering__TEAM1'

// Serves the team listing; any deeper query means the walk escaped its
// depth bound, so it fails loudly.
class TeamsOnlyTransport implements LinearTransport {
  graphql(query: string): Promise<Record<string, unknown>> {
    if (query.includes('teams(first:')) {
      return Promise.resolve({
        teams: { nodes: [TEAM], pageInfo: { hasNextPage: false, endCursor: null } },
      })
    }
    throw new Error(`unexpected query: ${query.slice(0, 60)}`)
  }
}

function spec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: stripSlash(virtual),
  })
}

async function runFind(
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]>,
): Promise<string[]> {
  const cmd = LINEAR_COMMANDS.find((c) => c.name === 'find')
  if (cmd === undefined) throw new Error('find not registered')
  const result = await cmd.fn(new LinearAccessor(new TeamsOnlyTransport()), paths, [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: null as unknown as Resource,
    index: new RAMIndexCacheStore(),
  })
  if (result === null) return []
  const [out] = result
  if (out === null) return []
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf).split('\n').filter(Boolean)
}

describe('linear factory find', () => {
  it('classifies directories via stat without an isDirName hint', async () => {
    const lines = await runFind([spec('/')], { maxdepth: '2' })
    expect(lines).toContain('/teams')
    expect(lines).toContain(TEAM_DIR)
  })

  it('filters static team entries by -name at depth three', async () => {
    const lines = await runFind([spec('/')], { maxdepth: '3', name: 'team.json' })
    expect(lines).toEqual([`${TEAM_DIR}/team.json`])
  })

  it('selects only directories with -type d', async () => {
    const lines = await runFind([spec('/')], { maxdepth: '3', type: 'd' })
    expect(lines).toContain(`${TEAM_DIR}/members`)
    expect(lines).toContain(`${TEAM_DIR}/issues`)
    expect(lines).not.toContain(`${TEAM_DIR}/team.json`)
  })
})
