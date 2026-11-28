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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SlackAccessor } from '../../accessor/slack.ts'
import { PathSpec } from '../../types.ts'
import { makeResolveGlob } from '../../utils/glob_walk.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { SlackVFS } from '../../vfs/slack/slack.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { SlackWorkspace } from '../../../tests/core/slack/workspace.ts'
import { rowsOf } from '../hierarchy/probe.ts'
import { readdir as slackReaddir } from './readdir.ts'

let origin = ''
let workspace: SlackWorkspace

beforeAll(async () => {
  origin = await serve('slack')
})

beforeEach(async () => {
  workspace = new SlackWorkspace(origin)
  await workspace.reset()
})

afterEach(async () => {
  await workspace.close()
})

async function listedPaths(accessor: SlackAccessor, path: PathSpec): Promise<string[]> {
  const base = path.virtual.replace(/\/$/, '')
  return rowsOf(await slackReaddir(accessor, path)).map((row) => `${base}/${row.name}`)
}

const resolveSlackGlob = (accessor: SlackAccessor, paths: PathSpec[]): Promise<PathSpec[]> =>
  makeResolveGlob((path) => listedPaths(accessor, path))(paths)

describe('resolveSlackGlob', () => {
  it('passes through resolved PathSpec unchanged', async () => {
    const resolved = new PathSpec({
      virtual: '/mnt/slack/channels/general__C1/2026-04-24.jsonl',
      directory: '/mnt/slack/channels/general__C1/',
      vfsPath: mountKey('/mnt/slack/channels/general__C1/2026-04-24.jsonl', '/mnt/slack'),
      resolved: true,
    })
    const out = await resolveSlackGlob(workspace.accessor(), [resolved])
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(resolved)
    expect(await workspace.run.requests()).toEqual([])
  })

  it('passes through unresolved PathSpec with no pattern unchanged', async () => {
    const noPattern = new PathSpec({
      virtual: '/mnt/slack/channels/general__C1',
      directory: '/mnt/slack/channels/general__C1',
      vfsPath: mountKey('/mnt/slack/channels/general__C1', '/mnt/slack'),
      resolved: false,
    })
    const out = await resolveSlackGlob(workspace.accessor(), [noPattern])
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(noPattern)
    expect(await workspace.run.requests()).toEqual([])
  })
})

describe('a glob through a mount', () => {
  it("matches a day's files by their names", async () => {
    // 2025-11-08 in general holds report.pdf, notes.txt and data.bin.
    const ws = new Workspace({ '/slack/': new SlackVFS({ accessor: workspace.accessor() }) }, {})
    try {
      const result = await ws.shell('echo /slack/channels/general__C1/2025-11-08/files/*.pdf')
      expect(result.stdoutText.split(/\s+/).filter((w) => w !== '')).toEqual([
        '/slack/channels/general__C1/2025-11-08/files/report__F2.pdf',
      ])
    } finally {
      await ws.close()
    }
  })
})
