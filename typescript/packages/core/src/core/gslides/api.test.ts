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
import { SlidesClient } from './api.ts'

const TOKEN_MANAGER = { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager
const DEC = new TextDecoder()

describe('SlidesClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads a presentation whole', async () => {
    vi.mocked(googleGet).mockResolvedValue({ presentationId: 'p1' })
    const out = await new SlidesClient(TOKEN_MANAGER).readPresentation('p1')
    expect(JSON.parse(DEC.decode(out))).toEqual({ presentationId: 'p1' })
    expect(googleGet).toHaveBeenCalledWith(
      TOKEN_MANAGER,
      'https://slides.googleapis.com/v1/presentations/p1',
    )
  })
})
