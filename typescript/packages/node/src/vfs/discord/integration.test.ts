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

import { MountMode } from '@struktoai/mirage-core/types'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Workspace } from '../../workspace.ts'
import { DiscordVFS } from '@struktoai/mirage-core/vfs/direct/discord'
import { serve } from '../../../../core/tests/fixtures/kit_fake.ts'
import { DiscordGuild } from '../../../../core/tests/fixtures/discord_guild.ts'

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

describe('DiscordVFS integration', () => {
  it('ls /discord/ returns top-level guild directory names', async () => {
    const ws = new Workspace(
      { '/discord': new DiscordVFS(guild.config()) },
      { mode: MountMode.READ },
    )
    try {
      const result = await ws.shell('ls /discord/')
      if (result.exitCode !== 0) {
        throw new Error(`ls failed: ${result.stderrText} | stdout: ${result.stdoutText}`)
      }
      expect(result.stdoutText).toContain('My Server__111')
    } finally {
      await ws.close()
    }
  })
})
