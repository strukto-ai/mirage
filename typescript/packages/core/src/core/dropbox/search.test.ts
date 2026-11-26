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
import { PathSpec } from '../../types.ts'
import type { JsonValue } from '../../types.ts'
import { DropboxAccount } from '../../../tests/core/dropbox/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { filesContaining } from './search.ts'

const SEARCH_ROUTE = '/2/files/search_v2'
const NEEDLE = new TextEncoder().encode('a needle in it')

let origin: string
let account: DropboxAccount

// Past the 20 s the fixture gives the fake to start, so a slow start fails
// with the fixture's message, not the hook's.
beforeAll(async () => {
  origin = await serve('dropbox')
}, 30_000)

beforeEach(() => {
  account = new DropboxAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

function mountRoot(): PathSpec {
  return new PathSpec({ virtual: '/data', directory: '/data', vfsPath: '' })
}

function subdir(): PathSpec {
  return new PathSpec({ virtual: '/data/docs', directory: '/data/docs', vfsPath: 'docs' })
}

// The virtual paths a search names, and the path it was scoped to.
async function ask(scope: PathSpec, rootPath?: string): Promise<[string[] | null, string]> {
  await account.run.recordRequests()
  const out = await filesContaining(account.accessor(rootPath), 'needle', [scope])
  const [sent] = (await account.run.bodies('POST', SEARCH_ROUTE)) as {
    options: { path?: string }
  }[]
  return [out === null ? null : out.map((p) => p.virtual).sort(), sent?.options.path ?? '']
}

function match(i: number): JsonValue {
  const path = `/f${String(i)}.txt`
  return {
    match_type: { '.tag': 'content' },
    metadata: {
      '.tag': 'metadata',
      metadata: { '.tag': 'file', name: path.slice(1), path_lower: path, path_display: path },
    },
  }
}

describe('filesContaining', () => {
  it('names each hit from its display path', async () => {
    await account.put('/x.txt', NEEDLE)
    await account.put('/Sub/Y.txt', NEEDLE)
    expect(await ask(mountRoot())).toEqual([['/data/Sub/Y.txt', '/data/x.txt'], ''])
  })

  // Dropbox answers each hit's path_lower beside its display case; the root
  // comes off the lowered one.
  it('strips the root path case-insensitively', async () => {
    await account.put('/Team/Sub/A.txt', NEEDLE)
    expect(await ask(mountRoot(), '/Team')).toEqual([['/data/Sub/A.txt'], '/Team'])
  })

  // A search scoped to /docs, given Dropbox's answer for the whole account:
  // the hit under /other is no path in the scope.
  it('drops hits outside the scope', async () => {
    await account.put('/docs/in.txt', NEEDLE)
    await account.put('/other/out.txt', NEEDLE)
    const everywhere = await account.run.call<{ matches: JsonValue[] }>('POST', SEARCH_ROUTE, {
      json: { query: 'needle' },
    })
    expect(everywhere.matches).toHaveLength(2)
    await account.run.answerNext('POST', SEARCH_ROUTE, 200, everywhere)
    expect(await ask(subdir())).toEqual([['/data/docs/in.txt'], '/docs'])
  })

  // No hit is distrusted too: Dropbox indexes a write after it lands.
  it.each(['a truncated answer', 'no hit', 'an API failure'])('is null for %s', async (answer) => {
    if (answer === 'a truncated answer') {
      const matches = Array.from({ length: 10_000 }, (_, i) => match(i))
      await account.run.answerNext('POST', SEARCH_ROUTE, 200, { matches, has_more: false })
    }
    if (answer === 'an API failure') await account.run.answerNext('POST', SEARCH_ROUTE, 500)
    expect(await filesContaining(account.accessor(), 'needle', [mountRoot()])).toBeNull()
  })
})
