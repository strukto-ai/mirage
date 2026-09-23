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

import { GmailAccessor } from '../../accessor/gmail.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { FileType, PathSpec } from '../../types.ts'
import type { TokenManager } from '../google/client.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { stat } from './stat.ts'

const STUB_TM = {} as TokenManager
const PREFIX = '/gmail'

function makeAccessor(): GmailAccessor {
  return new GmailAccessor({ tokenManager: STUB_TM })
}

function spec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    vfsPath: mountKey(virtual, PREFIX),
  })
}

async function warm(index: RAMIndexCacheStore): Promise<void> {
  await index.setDir('/gmail', [
    [
      'INBOX',
      new IndexEntry({
        id: 'INBOX',
        name: 'INBOX',
        resourceType: 'gmail/label',
        vfsName: 'INBOX',
      }),
    ],
  ])
  await index.setDir('/gmail/INBOX', [
    [
      '2026-04-12',
      new IndexEntry({
        id: '2026-04-12',
        name: '2026-04-12',
        resourceType: 'gmail/date',
        vfsName: '2026-04-12',
      }),
    ],
  ])
}

describe('gmail stat of a day directory', () => {
  it('answers a day the label listing minted', async () => {
    const index = new RAMIndexCacheStore()
    await warm(index)
    const result = await stat(makeAccessor(), spec('/gmail/INBOX/2026-04-12'), index)
    expect(result.type).toBe(FileType.DIRECTORY)
    expect(result.name).toBe('2026-04-12')
  })

  it('answers a day outside the listed window', async () => {
    // The label listing is a bounded window of recent messages, so it never
    // minted this day; the date query answers for any well-formed one, so the
    // label's existence is the proof rather than the window. Nothing is
    // fetched, which is why no API mock is needed.
    const index = new RAMIndexCacheStore()
    await warm(index)
    const result = await stat(makeAccessor(), spec('/gmail/INBOX/2020-01-01'), index)
    expect(result.type).toBe(FileType.DIRECTORY)
    expect(result.name).toBe('2020-01-01')
  })
})
