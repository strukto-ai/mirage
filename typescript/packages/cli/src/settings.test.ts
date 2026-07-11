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
import { describe, expect, it } from 'vitest'
import { DEFAULT_DAEMON_URL, loadDaemonSettings } from './settings.ts'

const ABSENT_FILE = '/nonexistent/auth_token'

describe('loadDaemonSettings', () => {
  it('returns defaults when env unset and no file', () => {
    const s = loadDaemonSettings({
      env: {},
      configPath: '/nonexistent/config.toml',
      tokenFile: ABSENT_FILE,
    })
    expect(s.url).toBe(DEFAULT_DAEMON_URL)
    expect(s.authToken).toBe('')
  })

  it('MIRAGE_DAEMON_URL overrides default', () => {
    const s = loadDaemonSettings({
      env: { MIRAGE_DAEMON_URL: 'http://10.0.0.1:9000' },
      configPath: '/nonexistent/config.toml',
      tokenFile: ABSENT_FILE,
    })
    expect(s.url).toBe('http://10.0.0.1:9000')
  })

  it('MIRAGE_TOKEN populates authToken', () => {
    const s = loadDaemonSettings({
      env: { MIRAGE_TOKEN: 'secret' },
      configPath: '/nonexistent/config.toml',
      tokenFile: ABSENT_FILE,
    })
    expect(s.authToken).toBe('secret')
  })

  it('falls back to token file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-cli-settings-'))
    try {
      const tokenFile = join(dir, 'auth_token')
      writeFileSync(tokenFile, 'from-file')
      const s = loadDaemonSettings({
        env: {},
        configPath: '/nonexistent/config.toml',
        tokenFile,
      })
      expect(s.authToken).toBe('from-file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads config.toml and token file under MIRAGE_HOME', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-cli-settings-'))
    try {
      writeFileSync(join(dir, 'config.toml'), '[daemon]\nurl = "http://127.0.0.1:9999"\n')
      writeFileSync(join(dir, 'auth_token'), 'home-token')
      const s = loadDaemonSettings({ env: { MIRAGE_HOME: dir } })
      expect(s.url).toBe('http://127.0.0.1:9999')
      expect(s.authToken).toBe('home-token')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
