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
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALLOWED_KEYS, NUMERIC_KEYS } from '../daemon_config.ts'
import { defaultSSHDir, resolveSSHConfig } from './config.ts'
import { DEFAULT_SSH_HOST, SSH_ENV_KEYS } from './constants.ts'
import { SSHConfigError } from './errors.ts'

const home = mkdtempSync(join(tmpdir(), 'mirage-ssh-config-'))

describe('resolveSSHConfig', () => {
  it('keeps the entry point shut without a port', () => {
    const shut = resolveSSHConfig({ env: {}, table: {}, home })
    expect(shut.port).toBeNull()
    expect(shut.hostKeyFile).toBe(join(home, 'ssh', 'host_ed25519_key'))
    expect(
      resolveSSHConfig({
        env: { MIRAGE_SSH_HOST: '0.0.0.0' },
        table: { ssh_host: '0.0.0.0' },
        home,
      }).port,
    ).toBeNull()
  })

  it('fills every default from a port alone', () => {
    expect(resolveSSHConfig({ env: { MIRAGE_SSH_PORT: '2222' }, table: {}, home })).toEqual({
      port: 2222,
      host: DEFAULT_SSH_HOST,
      hostKeyFile: join(home, 'ssh', 'host_ed25519_key'),
      authorizedKeysFile: join(home, 'ssh', 'authorized_keys'),
    })
  })

  it('takes from the table what env does not set', () => {
    const cfg = resolveSSHConfig({
      env: {},
      table: { ssh_port: '2200', ssh_host: '0.0.0.0', ssh_authorized_keys: '/etc/keys' },
      home,
    })
    expect(cfg.port).toBe(2200)
    expect(cfg.host).toBe('0.0.0.0')
    expect(cfg.authorizedKeysFile).toBe('/etc/keys')
  })

  it('lets env win over the table', () => {
    const cfg = resolveSSHConfig({
      env: { MIRAGE_SSH_PORT: '2300', MIRAGE_SSH_HOST: '10.0.0.1' },
      table: { ssh_port: '2200', ssh_host: '0.0.0.0' },
      home,
    })
    expect([cfg.port, cfg.host]).toEqual([2300, '10.0.0.1'])
  })

  it('expands the home directory in key paths', () => {
    const cfg = resolveSSHConfig({
      env: { MIRAGE_SSH_PORT: '2222', MIRAGE_SSH_HOST_KEY_FILE: '~/k' },
      table: {},
      home,
    })
    expect(cfg.hostKeyFile).toBe(join(homedir(), 'k'))
  })

  it.each(['ssh', '22.5', '0', '65536', '-1'])('refuses port %s by name', (raw) => {
    expect(() => resolveSSHConfig({ env: { MIRAGE_SSH_PORT: raw }, table: {}, home })).toThrow(
      SSHConfigError,
    )
    expect(() => resolveSSHConfig({ env: { MIRAGE_SSH_PORT: raw }, table: {}, home })).toThrow(
      /ssh_port/,
    )
  })

  it('reads no config file when env is explicit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ssh-home-'))
    writeFileSync(join(dir, 'config.toml'), '[daemon]\nssh_port = 2222\n')
    const env = { MIRAGE_HOME: dir }
    expect(resolveSSHConfig({ env }).port).toBeNull()
  })
})

describe('settings', () => {
  it('are all daemon config keys', () => {
    for (const key of Object.keys(SSH_ENV_KEYS)) expect(ALLOWED_KEYS.has(key)).toBe(true)
    expect(NUMERIC_KEYS.has('ssh_port')).toBe(true)
  })

  it('keep their files under the mirage home', () => {
    expect(defaultSSHDir(home)).toBe(join(home, 'ssh'))
  })
})
