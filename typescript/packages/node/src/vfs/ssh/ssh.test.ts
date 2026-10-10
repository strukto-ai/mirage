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

import { beforeEach, describe, expect, it } from 'vitest'
import '../../commands/builtin/backends.ts'
import { commandsFor } from '@struktoai/mirage-core/commands/builtin/backends'
import { VFSName } from '@struktoai/mirage-core/types'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { SSH_COMMANDS } from '../../commands/builtin/ssh/index.ts'
import { type FakeSftp, makeFakeAccessor } from '../../core/ssh/_test_utils.ts'
import type { SSHConfig } from './config.ts'
import { PROMPT } from './prompt.ts'
import { SSHVFS } from './ssh.ts'

function makeVfs(state: FakeSftp, config?: Partial<SSHConfig>): SSHVFS {
  const cfg: SSHConfig = {
    host: 'example.com',
    username: 'alice',
    password: 'secret',
    passphrase: 'phrase',
    ...config,
  }
  const fake = makeFakeAccessor(state, cfg.root ?? '/')
  const vfs = new SSHVFS(cfg)
  ;(vfs as { accessor: SSHAccessor }).accessor = fake
  return vfs
}

let state: FakeSftp

beforeEach(() => {
  state = { files: new Map(), dirs: new Map([['/', {}]]) }
})

describe('SSHVFS — identity', () => {
  it('exposes kind = ssh and cachesReads = true', () => {
    const res = makeVfs(state)
    expect(res.name).toBe(VFSName.SSH)
    expect(res.cachesReads).toBe(true)
  })

  it('prompt equals PROMPT', () => {
    const res = makeVfs(state)
    expect(res.prompt).toBe(PROMPT)
  })

  it('serves SSH_COMMANDS', () => {
    const res = makeVfs(state)
    expect(commandsFor(res)).toEqual(SSH_COMMANDS)
    expect(SSH_COMMANDS.map((c) => c.name)).toEqual(['cp', 'du', 'find'])
  })
})

describe('SSHVFS — getState / loadState', () => {
  it('redacts password and passphrase', async () => {
    const res = makeVfs(state)
    const result = await res.getState()
    expect(result.type).toBe(VFSName.SSH)
    expect(result).not.toHaveProperty('needsOverride')
    expect(result).not.toHaveProperty('redactedFields')
    expect(result.config.password).toBe('<REDACTED>')
    expect(result.config.passphrase).toBe('<REDACTED>')
    expect(result.config.host).toBe('example.com')
    expect(result.config.username).toBe('alice')
  })

  it('loadState is a no-op', async () => {
    const res = makeVfs(state)
    const result = await res.getState()
    await res.loadState(result)
    expect(await res.getState()).toEqual(result)
  })
})
