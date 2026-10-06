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
import { buildApp } from '../app.ts'

describe('documents router', () => {
  it('answers 404 for a session that does not exist', async () => {
    const app = buildApp()
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { id: 'dw', config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } },
    })
    const get = await app.inject({ method: 'GET', url: '/v1/workspaces/dw/sessions/ghost/vfs-md' })
    expect(get.statusCode).toBe(404)
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/workspaces/dw/skill-md?session_id=ghost',
      payload: { path: '/SKILL.md' },
    })
    expect(put.statusCode).toBe(404)
    await app.close()
  })
})
