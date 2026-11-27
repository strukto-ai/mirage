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
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import type { GoogleAccount } from '../../../tests/fixtures/google_account.ts'
import { HK, TODAY, calendarAccount, gcalConfig } from '../../../tests/fixtures/gcal_seed.ts'
import { parseBucket } from '../../core/gcal/day.ts'
import { compactJsonBytes } from '../../core/render/json.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { parseConfigWithSchema } from '../secrets.ts'
import { GCalConfig } from './config.ts'
import { GCalVFS } from './gcal.ts'

const EVENT = '/cal/primary/2026-08-11/aaaa1__0900-1030_PhD_Defense.gcal.json'

let origin: string
let account: GoogleAccount

beforeAll(async () => {
  origin = await serve('gws')
})

beforeEach(async () => {
  account = await calendarAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

function workspace(): Workspace {
  return new Workspace({ '/cal': new GCalVFS(gcalConfig(account)) })
}

describe('gcal VFS', () => {
  // gcal's read is the by-VFS op: an event resolves as ".json" at the dispatcher,
  // so a read keyed to ".gcal.json" was never picked and a cold read failed
  // until a cat warmed the file cache.
  it.each([
    ['whole', {}, [0, undefined]],
    ['raw', { raw: true }, [0, undefined]],
    ['range', { offset: 2, size: 10 }, [2, 12]],
  ] as const)('reads an event cold at the dispatcher (%s)', async (_label, options, [lo, hi]) => {
    const whole = compactJsonBytes(await account.eventItem('aaaa1'))
    expect(await workspace().vfs.read(EVENT, options)).toEqual(whole.slice(lo, hi))
  })

  it('reads calendar.json cold at the dispatcher', async () => {
    const text = new TextDecoder().decode(await workspace().vfs.read('/cal/primary/calendar.json'))
    expect(JSON.parse(text)).toMatchObject({ bucketTimeZone: HK })
  })

  it.each([1, 7, 30])('shows the mount its own tree (%i)', async (size) => {
    // The tree is the mount's own shape, drawn without a request.
    const config = parseConfigWithSchema(GCalConfig, {
      client_id: 'cid',
      refresh_token: 'rt',
      today: TODAY,
      bucket_days: size,
    })
    const vfs = new GCalVFS(config)
    const text = await new Workspace({ '/cal': vfs }).vfsMd()
    const [, bucket = '', name = ''] =
      /primary\/\s+calendar\.json\s+(\S+)\/\s+<eventId>__(\S+)/.exec(text) ?? []
    expect(parseBucket(bucket, size)).not.toBeNull()
    expect(name.startsWith('2026-08-11_')).toBe(size > 1)
  })

  it('buckets by day when constructed without bucketDays', async () => {
    const vfs = new GCalVFS({ accessToken: 't' })
    expect(vfs.config.bucketDays).toBe(1)
    const text = await new Workspace({ '/cal': vfs }).vfsMd()
    expect(text).toContain('    2026-08-11/\n      <eventId>__0900-1030_Team_Standup.gcal.json')
    expect(text).toContain('A bucket is one local day')
  })
})
