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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MessagesModule from './messages.ts'
import type * as LabelsModule from './labels.ts'

vi.mock('./messages.ts', async () => {
  const actual = await vi.importActual<typeof MessagesModule>('./messages.ts')
  return { ...actual, listMessages: vi.fn(), getMessageRaw: vi.fn() }
})

vi.mock('./labels.ts', async () => {
  const actual = await vi.importActual<typeof LabelsModule>('./labels.ts')
  return { ...actual, listLabels: vi.fn() }
})

import { GmailAccessor } from '../../accessor/gmail.ts'
import type { Evicted, IndexEntry, SetDirOptions } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import type { TokenManager } from '../google/client.ts'
import * as labelsMod from './labels.ts'
import * as messagesMod from './messages.ts'
import { readdir } from './readdir.ts'

class WindowSpy extends RAMIndexCacheStore {
  readonly windows = new Map<string, boolean>()

  override setDir(
    vfsPath: string,
    entries: readonly [string, IndexEntry][],
    expiredAt?: Date | null,
    options: SetDirOptions = {},
  ): Promise<Evicted[]> {
    this.windows.set(vfsPath, options.window === true)
    return super.setDir(vfsPath, entries, expiredAt, options)
  }
}

const ACCESSOR = new GmailAccessor({ tokenManager: {} as TokenManager, config: {} })

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, '/gmail') })
}

describe('gmail readdir windows', () => {
  beforeEach(() => {
    vi.mocked(labelsMod.listLabels).mockResolvedValue([{ id: 'INBOX', type: 'system' }])
    vi.mocked(messagesMod.listMessages).mockResolvedValue([{ id: 'x1' }])
    vi.mocked(messagesMod.getMessageRaw).mockResolvedValue({
      id: 'x1',
      internalDate: String(Date.UTC(2026, 3, 27)),
      payload: { headers: [{ name: 'Subject', value: 'Hi 27' }] },
    })
  })

  it('writes a label and the day it seeds as windows', async () => {
    // Both fetches stop at MAX_MESSAGES, so what they name is a window: a
    // message outside it has not gone anywhere.
    const index = new WindowSpy()
    for (const path of ['/gmail/INBOX', '/gmail/INBOX/2026-04-27']) {
      await readdir(ACCESSOR, spec(path), index)
    }
    expect(index.windows.get('/gmail/INBOX')).toBe(true)
    expect(index.windows.get('/gmail/INBOX/2026-04-27')).toBe(true)
  })

  it('writes a day listed on its own as a window', async () => {
    // The label listing seeds its days, so a day read after it never reaches
    // the day lister; listing the day first is what exercises that lister.
    const index = new WindowSpy()
    await readdir(ACCESSOR, spec('/gmail/INBOX/2026-04-27'), index)
    expect(index.windows.has('/gmail/INBOX')).toBe(false)
    expect(index.windows.get('/gmail/INBOX/2026-04-27')).toBe(true)
  })
})
