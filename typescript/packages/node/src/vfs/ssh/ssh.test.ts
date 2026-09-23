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
import { VFSName } from '@struktoai/mirage-core/types'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { SSH_COMMANDS } from '../../commands/builtin/ssh/index.ts'
import { type FakeSftp, makeFakeAccessor } from '../../core/ssh/_test_utils.ts'
import { SSH_OPS } from '../../ops/ssh/index.ts'
import type { SSHConfig } from './config.ts'
import { SSH_PROMPT } from './prompt.ts'
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
    expect(res.kind).toBe(VFSName.SSH)
    expect(res.cachesReads).toBe(true)
  })

  it('prompt equals SSH_PROMPT', () => {
    const res = makeVfs(state)
    expect(res.prompt).toBe(SSH_PROMPT)
  })

  it('commands() length matches SSH_COMMANDS', () => {
    const res = makeVfs(state)
    expect(res.commands().length).toBe(SSH_COMMANDS.length)
    expect(res.commands().length).toBe(71)
  })

  it('ops() length matches SSH_OPS', () => {
    const res = makeVfs(state)
    expect(res.ops().length).toBe(SSH_OPS.length)
    expect(res.ops().length).toBe(12)
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
    await expect(res.loadState(result)).resolves.toBeUndefined()
  })
})
