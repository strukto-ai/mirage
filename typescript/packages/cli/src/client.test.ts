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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonConfigError } from '@struktoai/mirage-server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonClient } from './client.ts'

describe('DaemonClient spawn config validation', () => {
  let home: string
  let originalHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mirage-cli-client-'))
    originalHome = process.env.MIRAGE_HOME
    process.env.MIRAGE_HOME = home
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.MIRAGE_HOME
    else process.env.MIRAGE_HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  it('refuses to spawn when config.toml has an unknown key', async () => {
    writeFileSync(join(home, 'config.toml'), '[daemon]\ntypo_key = "x"\n')
    const client = new DaemonClient({
      url: 'http://127.0.0.1:1',
      authToken: 't',
      idleGraceSeconds: 30,
    })
    await expect(client.ensureRunning({ timeoutMs: 500 })).rejects.toThrow(DaemonConfigError)
    await expect(client.ensureRunning({ timeoutMs: 500 })).rejects.toThrow(/typo_key/)
  })
})
