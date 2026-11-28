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
import type { DiscordAccessor } from '../../accessor/discord.ts'
import { PathSpec } from '../../types.ts'
import { makeResolveGlob } from '../../utils/glob_walk.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { DiscordGuild } from '../../../tests/core/discord/guild.ts'
import { mountDiscord } from '../../../tests/workspace/fixtures/chat_fixture.ts'
import { rowsOf } from '../hierarchy/probe.ts'
import { readdir as discordReaddir } from './readdir.ts'

let origin = ''
let guild: DiscordGuild

beforeAll(async () => {
  origin = await serve('discord')
})

beforeEach(async () => {
  guild = new DiscordGuild(origin)
  await guild.reset()
})

afterEach(async () => {
  await guild.close()
})

async function listedPaths(accessor: DiscordAccessor, path: PathSpec): Promise<string[]> {
  const base = path.virtual.replace(/\/$/, '')
  return rowsOf(await discordReaddir(accessor, path)).map((row) => `${base}/${row.name}`)
}

const resolveDiscordGlob = (accessor: DiscordAccessor, paths: PathSpec[]): Promise<PathSpec[]> =>
  makeResolveGlob((path) => listedPaths(accessor, path))(paths)

describe('resolveDiscordGlob', () => {
  it('passes through resolved PathSpec unchanged', async () => {
    const resolved = new PathSpec({
      virtual: '/mnt/discord/My Server__G1/channels/general__C1/2026-04-24.jsonl',
      directory: '/mnt/discord/My Server__G1/channels/general__C1/',
      vfsPath: mountKey(
        '/mnt/discord/My Server__G1/channels/general__C1/2026-04-24.jsonl',
        '/mnt/discord',
      ),
      resolved: true,
    })
    const out = await resolveDiscordGlob(guild.accessor(), [resolved])
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(resolved)
    expect(await guild.run.requests()).toEqual([])
  })

  it('passes through unresolved PathSpec with no pattern unchanged', async () => {
    const noPattern = new PathSpec({
      virtual: '/mnt/discord/My Server__G1/channels/general__C1',
      directory: '/mnt/discord/My Server__G1/channels/general__C1',
      vfsPath: mountKey('/mnt/discord/My Server__G1/channels/general__C1', '/mnt/discord'),
      resolved: false,
    })
    const out = await resolveDiscordGlob(guild.accessor(), [noPattern])
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(noPattern)
    expect(await guild.run.requests()).toEqual([])
  })
})

describe('a glob through a mount', () => {
  it("matches a channel's days by their names", async () => {
    // general's last message is 2024-01-16, so the window holds 2024-01-10
    // through 01-16.
    const ws = mountDiscord(guild.accessor())
    try {
      const result = await ws.shell(
        'echo "/mnt/discord/My Server__111/channels/general__211/"2024-01-1*',
      )
      const days = result.stdoutText
        .split('/mnt/discord/')
        .filter((w) => w.trim() !== '')
        .map((w) => w.trim().slice(-10))
      expect(days).toEqual([
        '2024-01-10',
        '2024-01-11',
        '2024-01-12',
        '2024-01-13',
        '2024-01-14',
        '2024-01-15',
        '2024-01-16',
      ])
    } finally {
      await ws.close()
    }
  })
})
