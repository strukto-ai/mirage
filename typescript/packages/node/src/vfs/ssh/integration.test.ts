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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PathSpec } from '@struktoai/mirage-core/types'
import type { SSHConfig } from './config.ts'
import { SSHVFS } from './ssh.ts'

const HOST = process.env.SSH_TEST_HOST
const enabled = HOST !== undefined && HOST !== ''
const FILE = process.env.SSH_TEST_FILE ?? '/etc/hostname'
const TMPDIR = process.env.SSH_TEST_TMPDIR ?? '/tmp'
const READONLY = process.env.SSH_TEST_READONLY === '1'

describe.skipIf(!enabled)('SSH integration (live host)', () => {
  let r: SSHVFS

  beforeAll(() => {
    const cfg: SSHConfig = {
      host: HOST ?? '',
      username: process.env.SSH_TEST_USER ?? 'root',
      root: '/',
    }
    if (process.env.SSH_TEST_KEY !== undefined) cfg.identityFile = process.env.SSH_TEST_KEY
    if (process.env.SSH_TEST_PASSWORD !== undefined) cfg.password = process.env.SSH_TEST_PASSWORD
    if (process.env.SSH_TEST_PORT !== undefined) cfg.port = Number(process.env.SSH_TEST_PORT)
    r = new SSHVFS(cfg)
  })

  afterAll(async () => {
    await r.close()
  })

  it('readdir / returns entries', async () => {
    const entries = await r.readdir(PathSpec.fromStrPath('/'))
    expect(entries.length).toBeGreaterThan(0)
  })

  it(`stat ${FILE} returns size > 0`, async () => {
    const s = await r.stat(PathSpec.fromStrPath(FILE))
    expect(s.size ?? 0).toBeGreaterThan(0)
  })

  it(`readFile ${FILE} returns non-empty bytes`, async () => {
    const data = await r.readFile(PathSpec.fromStrPath(FILE))
    expect(data.byteLength).toBeGreaterThan(0)
  })

  const writeIt = READONLY ? it.skip : it
  writeIt('round-trip write/read/unlink under tmpdir', async () => {
    const random = Math.random().toString(36).slice(2, 10)
    const path = `${TMPDIR}/mirage-ssh-test-${random}.txt`
    const payload = new TextEncoder().encode(`hello ${random}\n`)
    const ps = PathSpec.fromStrPath(path)
    await r.writeFile(ps, payload)
    try {
      const back = await r.readFile(ps)
      expect(new TextDecoder().decode(back)).toBe(`hello ${random}\n`)
    } finally {
      await r.unlink(ps)
    }
  })
})
