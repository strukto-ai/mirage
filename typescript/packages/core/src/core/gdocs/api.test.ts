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
import type * as ClientModule from '../google/client.ts'

vi.mock('../google/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof ClientModule>()),
  googleGet: vi.fn(),
}))

import { googleGet, type TokenManager } from '../google/client.ts'
import { DocsClient } from './api.ts'

const TOKEN_MANAGER = { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager
const DEC = new TextDecoder()

describe('DocsClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads a document with every tab, so a multi-tab one is not truncated', async () => {
    const doc = { documentId: 'abc123', title: 'Test Doc', tabs: [] }
    vi.mocked(googleGet).mockResolvedValue(doc)
    const out = await new DocsClient(TOKEN_MANAGER).readDoc('abc123')
    expect(JSON.parse(DEC.decode(out))).toEqual(doc)
    expect(googleGet).toHaveBeenCalledWith(
      TOKEN_MANAGER,
      'https://docs.googleapis.com/v1/documents/abc123',
      { includeTabsContent: 'true' },
    )
  })
})
