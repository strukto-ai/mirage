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

import { beforeEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { connectOptions } from './ssh.ts'

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))
vi.mock('node:os', () => ({ homedir: () => '/test-home', userInfo: () => ({ username: 'agent' }) }))
const read = vi.mocked(readFile)
beforeEach(() => {
  read.mockReset()
})
it('tries default keys and preserves the connection deadline', async () => {
  read.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  read.mockResolvedValueOnce(Buffer.from('key'))
  const options = await connectOptions('alias', 'host', 2222, undefined, undefined, 3)
  expect(options).toMatchObject({ host: 'host', port: 2222, username: 'agent', readyTimeout: 3000 })
  expect(read.mock.calls.map(([path]) => path)).toEqual(
    ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa'].map((name) => '/test-home/.ssh/' + name),
  )
  expect(options.authHandler).toContainEqual({
    type: 'publickey',
    username: 'agent',
    key: Buffer.from('key'),
  })
})
it('skips unreadable default keys but not a missing explicit one', async () => {
  read.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
  const options = await connectOptions('host', undefined, undefined, undefined, undefined, 2)
  expect((options.authHandler as { type: string }[]).map((method) => method.type)).not.toContain(
    'publickey',
  )
  read.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  await expect(connectOptions('host', undefined, undefined, undefined, '~/key', 2)).rejects.toThrow(
    'missing',
  )
  expect(read).toHaveBeenLastCalledWith('/test-home/key')
})
