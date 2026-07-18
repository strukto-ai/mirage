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

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DAEMON_URL,
  getConfig,
  listConfig,
  loadDaemonSettings,
  resolvedConfig,
  setConfig,
  unsetConfig,
} from './settings.ts'

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

  it('reads the exact configPath even when the basename is not config.toml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-cli-settings-'))
    try {
      const configPath = join(dir, 'custom.toml')
      writeFileSync(configPath, '[daemon]\nurl = "http://127.0.0.1:8888"\n')
      const s = loadDaemonSettings({ env: {}, configPath, tokenFile: ABSENT_FILE })
      expect(s.url).toBe('http://127.0.0.1:8888')
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

describe('config writer', () => {
  function tmpConfigPath(): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-cli-config-'))
    return { dir, path: join(dir, 'config.toml') }
  }

  it('setConfig creates the file and [daemon] header when missing', () => {
    const { dir, path } = tmpConfigPath()
    try {
      setConfig('url', 'http://127.0.0.1:9000', path)
      const text = readFileSync(path, 'utf-8')
      expect(text).toBe('[daemon]\nurl = "http://127.0.0.1:9000"\n')
      expect(getConfig('url', path)).toBe('http://127.0.0.1:9000')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('setConfig updates an existing key in place without duplicating', () => {
    const { dir, path } = tmpConfigPath()
    try {
      writeFileSync(path, '[daemon]\nurl = "http://old:1"\n')
      setConfig('url', 'http://new:2', path)
      const text = readFileSync(path, 'utf-8')
      expect(text).toBe('[daemon]\nurl = "http://new:2"\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('setConfig preserves comments and unrelated keys, appending inside [daemon]', () => {
    const { dir, path } = tmpConfigPath()
    try {
      writeFileSync(
        path,
        '# a comment\n[daemon]\n# keep me\nurl = "http://old:1"\n\n[other]\nfoo = "bar"\n',
      )
      setConfig('auth_token', 'secret', path)
      const text = readFileSync(path, 'utf-8')
      expect(text).toBe(
        '# a comment\n[daemon]\n# keep me\nurl = "http://old:1"\n\nauth_token = "secret"\n[other]\nfoo = "bar"\n',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('numeric idle_grace_seconds is written bare (unquoted)', () => {
    const { dir, path } = tmpConfigPath()
    try {
      setConfig('idle_grace_seconds', '45', path)
      const text = readFileSync(path, 'utf-8')
      expect(text).toBe('[daemon]\nidle_grace_seconds = 45\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('string values escape backslashes and quotes', () => {
    const { dir, path } = tmpConfigPath()
    try {
      setConfig('auth_token', 'a\\b"c', path)
      const text = readFileSync(path, 'utf-8')
      expect(text).toBe('[daemon]\nauth_token = "a\\\\b\\"c"\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('unsetConfig removes the key', () => {
    const { dir, path } = tmpConfigPath()
    try {
      writeFileSync(path, '[daemon]\nurl = "http://old:1"\nauth_token = "secret"\n')
      unsetConfig('url', path)
      expect(getConfig('url', path)).toBeUndefined()
      expect(getConfig('auth_token', path)).toBe('secret')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('unsetConfig leaves exactly one trailing newline', () => {
    const { dir, path } = tmpConfigPath()
    try {
      writeFileSync(path, '[daemon]\nurl = "http://old:1"\nsocket = "/tmp/s"\n')
      unsetConfig('socket', path)
      expect(readFileSync(path, 'utf-8')).toBe('[daemon]\nurl = "http://old:1"\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('unsetConfig is a no-op when the file is absent', () => {
    const { dir, path } = tmpConfigPath()
    try {
      expect(() => {
        unsetConfig('url', path)
      }).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('listConfig returns every written key', () => {
    const { dir, path } = tmpConfigPath()
    try {
      setConfig('url', 'http://127.0.0.1:9000', path)
      setConfig('idle_grace_seconds', '10', path)
      expect(listConfig(path)).toEqual({
        url: 'http://127.0.0.1:9000',
        idle_grace_seconds: '10',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('listConfig returns {} when the file is absent', () => {
    const { dir, path } = tmpConfigPath()
    try {
      expect(listConfig(path)).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('getConfig returns undefined when the key is unset', () => {
    const { dir, path } = tmpConfigPath()
    try {
      setConfig('url', 'http://127.0.0.1:9000', path)
      expect(getConfig('auth_token', path)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('round-trips a backslash-containing value through setConfig/getConfig', () => {
    const { dir, path } = tmpConfigPath()
    try {
      setConfig('socket', 'C:\\pipes\\mirage', path)
      expect(getConfig('socket', path)).toBe('C:\\pipes\\mirage')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('round-trips a value through a non-config.toml path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-cli-config-'))
    try {
      const path = join(dir, 'custom.toml')
      setConfig('url', 'http://x:1', path)
      expect(getConfig('url', path)).toBe('http://x:1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a key outside ALLOWED_KEYS', () => {
    const { dir, path } = tmpConfigPath()
    try {
      expect(() => {
        setConfig('MIRAGE_HOME', '/tmp', path)
      }).toThrow(/unknown config key/)
      expect(() => {
        getConfig('MIRAGE_HOME', path)
      }).toThrow(/unknown config key/)
      expect(() => {
        unsetConfig('MIRAGE_HOME', path)
      }).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('config writer hardening', () => {
  it('setConfig chmods the file to 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-cli-config-'))
    try {
      const path = join(dir, 'config.toml')
      setConfig('auth_token', 's3cret', path)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('unsetConfig chmods the file to 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-cli-config-'))
    try {
      const path = join(dir, 'config.toml')
      writeFileSync(path, '[daemon]\nurl = "http://a:1"\nsocket = "/tmp/s"\n')
      unsetConfig('socket', path)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('unsetConfig accepts unknown keys so a broken file can be repaired', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-cli-config-'))
    try {
      const path = join(dir, 'config.toml')
      writeFileSync(path, '[daemon]\ntypo_key = "x"\nurl = "http://a:1"\n')
      unsetConfig('typo_key', path)
      const text = readFileSync(path, 'utf-8')
      expect(text).not.toContain('typo_key')
      expect(text).toContain('url = "http://a:1"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolvedConfig', () => {
  it('reports env, file, and default origins', () => {
    const home = mkdtempSync(join(tmpdir(), 'mirage-cli-resolved-'))
    try {
      writeFileSync(join(home, 'config.toml'), '[daemon]\nport = 9001\nurl = "http://f:1"\n')
      const env = { MIRAGE_HOME: home, MIRAGE_DAEMON_PORT: '9314' }
      const resolved = resolvedConfig(env)
      expect(resolved.port).toEqual(['9314', 'env MIRAGE_DAEMON_PORT'])
      expect(resolved.url).toEqual(['http://f:1', 'file'])
      expect(resolved.idle_grace_seconds).toEqual(['30', 'default'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('yields defaults when nothing is set', () => {
    const home = mkdtempSync(join(tmpdir(), 'mirage-cli-resolved-'))
    try {
      const env = { MIRAGE_HOME: home }
      const resolved = resolvedConfig(env)
      expect(resolved.url).toEqual([DEFAULT_DAEMON_URL, 'default'])
      expect(resolved.idle_grace_seconds).toEqual(['30', 'default'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('resolvedConfig port', () => {
  it('defaults to 8765 and honors MIRAGE_DAEMON_PORT', () => {
    const home = mkdtempSync(join(tmpdir(), 'mirage-cli-resolved-'))
    try {
      expect(resolvedConfig({ MIRAGE_HOME: home }).port).toEqual(['8765', 'default'])
      expect(resolvedConfig({ MIRAGE_HOME: home, MIRAGE_DAEMON_PORT: '9100' }).port).toEqual([
        '9100',
        'env MIRAGE_DAEMON_PORT',
      ])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
