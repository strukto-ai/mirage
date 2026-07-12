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

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.ts'
import { DaemonConfigError } from './daemon_config.ts'

describe('buildApp pid file wiring', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('explicit pidFile option wins over env', async () => {
    vi.stubEnv('MIRAGE_PID_FILE', '/run/env.pid')
    const app = buildApp({ pidFile: '/x/y.pid' })
    expect(app.pidFile).toBe('/x/y.pid')
    await app.close()
  })

  it('resolves MIRAGE_PID_FILE from env', async () => {
    vi.stubEnv('MIRAGE_PID_FILE', '/run/env.pid')
    const app = buildApp()
    expect(app.pidFile).toBe('/run/env.pid')
    await app.close()
  })

  it('defaults under MIRAGE_HOME', async () => {
    vi.stubEnv('MIRAGE_HOME', '/data/mirage')
    vi.stubEnv('MIRAGE_PID_FILE', '')
    const app = buildApp()
    expect(app.pidFile).toBe(join('/data/mirage', 'daemon.pid'))
    await app.close()
  })
})

describe('buildApp config validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('rejects an unknown [daemon] key at startup', () => {
    const home = mkdtempSync(join(tmpdir(), 'mir-app-'))
    writeFileSync(join(home, 'config.toml'), '[daemon]\ntypo_key = "x"\n')
    vi.stubEnv('MIRAGE_HOME', home)
    vi.stubEnv('MIRAGE_PID_FILE', '')
    expect(() => buildApp()).toThrow(DaemonConfigError)
    expect(() => buildApp()).toThrow(/typo_key/)
  })

  it('accepts a valid config.toml', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mir-app-'))
    writeFileSync(join(home, 'config.toml'), '[daemon]\nurl = "http://h:1"\n')
    vi.stubEnv('MIRAGE_HOME', home)
    vi.stubEnv('MIRAGE_PID_FILE', '')
    const app = buildApp()
    await app.close()
  })
})
