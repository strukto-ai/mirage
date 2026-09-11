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
import { normalizeSshConfig, redactSshConfig } from './config.ts'

describe('SSHConfig', () => {
  it('normalizes snake_case from YAML', () => {
    const c = normalizeSshConfig({
      host: 'example.com',
      identity_file: '~/.ssh/id_ed25519',
      known_hosts: '~/.ssh/known_hosts',
      port: 2222,
    })
    expect(c.host).toBe('example.com')
    expect(c.identityFile).toBe('~/.ssh/id_ed25519')
    expect(c.knownHosts).toBe('~/.ssh/known_hosts')
    expect(c.port).toBe(2222)
  })

  it('redacts password but not identityFile path', () => {
    const c = redactSshConfig({
      host: 'example.com',
      password: 'secret',
      identityFile: '~/.ssh/id_ed25519',
    })
    expect(c.password).toBe('<REDACTED>')
    expect(c.identityFile).toBe('~/.ssh/id_ed25519')
  })

  it('refuses a wrong-typed field instead of casting it through', () => {
    expect(() => normalizeSshConfig({ host: 'example.com', port: '2222' })).toThrow(/port/)
  })

  it('redacts passphrase too', () => {
    const c = redactSshConfig({
      host: 'example.com',
      passphrase: 'mypass',
    })
    expect(c.passphrase).toBe('<REDACTED>')
  })
})
