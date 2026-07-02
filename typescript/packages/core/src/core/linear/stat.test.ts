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

import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { LinearAccessor } from '../../accessor/linear.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { FileType, PathSpec } from '../../types.ts'
import type { LinearTransport } from './_client.ts'
import { stat } from './stat.ts'

class NoopTransport implements LinearTransport {
  graphql(): Promise<Record<string, unknown>> {
    throw new Error('should not be called')
  }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: mountKey(virtual, prefix) })
}

describe('linear stat modified', () => {
  it('returns modified from the cached team entry', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.put(
      '/teams/ENG__Engineering__TEAM1',
      new IndexEntry({
        id: 'TEAM1',
        name: 'Engineering',
        resourceType: 'linear/team',
        remoteTime: '2026-04-05T00:00:00Z',
        vfsName: 'ENG__Engineering__TEAM1',
      }),
    )
    const s = await stat(
      new LinearAccessor(new NoopTransport()),
      spec('/teams/ENG__Engineering__TEAM1'),
      idx,
    )
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.extra.team_id).toBe('TEAM1')
    expect(s.modified).toBe('2026-04-05T00:00:00Z')
  })
})
