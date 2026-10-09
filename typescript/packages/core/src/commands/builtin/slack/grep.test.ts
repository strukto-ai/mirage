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

import { invoke } from '../../../io/stdio.ts'
import { materialize } from '../../../io/types.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { SlackAccessor } from '../../../accessor/slack.ts'
import { describe, expect, it } from 'vitest'
import { ioFor } from '../../../test-utils.ts'
import { SlackVFSBase } from '../../../vfs/slack/slack.ts'
import { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import { PathSpec } from '../../../types.ts'
import { FakeSlackTransport, seedChannel } from './_test_util.ts'
import { SLACK_GREP } from './grep.ts'

describe('slack grep on a time-scoped mount', () => {
  it('scans instead of searching, so a bare directory is EISDIR', async () => {
    const idx = new RAMIndexCacheStore()
    await seedChannel(idx, '/mnt/slack', 'general__C1', 'C1', { dates: ['2026-01-02'] })
    const transport = new FakeSlackTransport()
    const cmd = SLACK_GREP[0]
    if (cmd === undefined) throw new Error('grep not registered')
    const accessor = new SlackAccessor(transport, { startTime: '2026-01-01T00:00:00Z' })
    const result = await invoke(() =>
      cmd.fn(
        accessor,
        [
          new PathSpec({
            virtual: '/mnt/slack/channels/general__C1',
            directory: '/mnt/slack/channels/general__C1',
            resolved: false,
            vfsPath: mountKey('/mnt/slack/channels/general__C1', '/mnt/slack'),
          }),
        ],
        ['hello'],
        {
          stdin: null,
          flags: { w: true },
          io: ioFor(SlackVFSBase, accessor),
          cwd: '/',
          index: idx,
        },
      ),
    )
    expect(transport.calls.map((c) => c.endpoint)).not.toContain('search.messages')
    expect(await materialize(result?.[0] ?? null)).toEqual(new Uint8Array())
    expect(result?.[1].exitCode).toBe(2)
    expect(await result?.[1].stderrStr()).toContain('Is a directory')
  })
})
