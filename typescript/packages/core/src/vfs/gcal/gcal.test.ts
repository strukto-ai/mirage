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

import { describe, expect, it, vi } from 'vitest'
import { EVENTS, HK, gcalConfig } from '../../core/gcal/_test_util.ts'
import { parseBucket } from '../../core/gcal/day.ts'
import { compactJsonBytes } from '../../core/render/json.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { GCalVFS } from './gcal.ts'

vi.mock(
  '../../core/gcal/client.ts',
  async () => (await import('../../core/gcal/_test_util.ts')).CLIENT,
)

const EVENT = '/cal/primary/2026-08-11/aaaa1__0900-1030_PhD_Defense.gcal.json'
const WHOLE = compactJsonBytes(EVENTS[0] ?? {})

function workspace(): Workspace {
  return new Workspace({ '/cal': new GCalVFS(gcalConfig()) })
}

describe('gcal VFS', () => {
  // gcal's read is the by-VFS op: an event resolves as ".json" at the door,
  // so a read keyed to ".gcal.json" was never picked and a cold read failed
  // until a cat warmed the file cache.
  it.each([
    ['whole', {}, WHOLE],
    ['raw', { raw: true }, WHOLE],
    ['range', { offset: 2, size: 10 }, WHOLE.slice(2, 12)],
  ])('reads an event cold at the op door (%s)', async (_label, options, data) => {
    expect(await workspace().vfs.read(EVENT, options)).toEqual(data)
  })

  it('reads calendar.json cold at the op door', async () => {
    const text = await workspace().vfs.cat('/cal/primary/calendar.json')
    expect(JSON.parse(text)).toMatchObject({ bucketTimeZone: HK })
  })

  it.each([1, 7, 30])('shows the mount its own tree (%i)', async (size) => {
    const vfs = new GCalVFS(gcalConfig({ bucket_days: size }))
    const text = await new Workspace({ '/cal': vfs }).vfsMd()
    const [, bucket = '', name = ''] = /\/primary\/([^/]+)\/<eventId>__(\S+)/.exec(text) ?? []
    expect(parseBucket(bucket, size)).not.toBeNull()
    expect(name.startsWith('2026-08-11_')).toBe(size > 1)
    expect(text).toContain(`--params '{"calendarId":"primary"}'`)
  })
})
