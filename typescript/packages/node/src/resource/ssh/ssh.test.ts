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
import { ResourceName } from '@struktoai/mirage-core'
import { spec } from '../../test-utils.ts'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { SSH_COMMANDS } from '../../commands/builtin/ssh/index.ts'
import { type FakeSftp, makeFakeAccessor } from '../../core/ssh/_test_utils.ts'
import { SSH_OPS } from '../../ops/ssh/index.ts'
import type { SSHConfig } from './config.ts'
import { SSH_PROMPT } from './prompt.ts'
import { SSHResource } from './ssh.ts'

function makeResource(state: FakeSftp, config?: Partial<SSHConfig>): SSHResource {
  const cfg: SSHConfig = {
    host: 'example.com',
    username: 'alice',
    password: 'secret',
    passphrase: 'phrase',
    ...config,
  }
  const fake = makeFakeAccessor(state, cfg.root ?? '/')
  const resource = new SSHResource(cfg)
  ;(resource as { accessor: SSHAccessor }).accessor = fake
  return resource
}

let state: FakeSftp

beforeEach(() => {
  state = { files: new Map(), dirs: new Map([['/', {}]]) }
})

describe('SSHResource — identity', () => {
  it('exposes kind = ssh and cachesReads = true', () => {
    const res = makeResource(state)
    expect(res.kind).toBe(ResourceName.SSH)
    expect(res.cachesReads).toBe(true)
  })

  it('prompt equals SSH_PROMPT', () => {
    const res = makeResource(state)
    expect(res.prompt).toBe(SSH_PROMPT)
  })

  it('commands() length matches SSH_COMMANDS', () => {
    const res = makeResource(state)
    expect(res.commands().length).toBe(SSH_COMMANDS.length)
    expect(res.commands().length).toBe(111)
  })

  it('ops() length matches SSH_OPS', () => {
    const res = makeResource(state)
    expect(res.ops().length).toBe(SSH_OPS.length)
    expect(res.ops().length).toBe(11)
  })
})

describe('SSHResource — getState / loadState', () => {
  it('redacts password and passphrase', async () => {
    const res = makeResource(state)
    const result = await res.getState()
    expect(result.type).toBe(ResourceName.SSH)
    expect(result).not.toHaveProperty('needsOverride')
    expect(result).not.toHaveProperty('redactedFields')
    expect(result.config.password).toBe('<REDACTED>')
    expect(result.config.passphrase).toBe('<REDACTED>')
    expect(result.config.host).toBe('example.com')
    expect(result.config.username).toBe('alice')
  })

  it('loadState is a no-op', async () => {
    const res = makeResource(state)
    const result = await res.getState()
    await expect(res.loadState(result)).resolves.toBeUndefined()
  })
})

describe('SSHResource — fingerprint', () => {
  it('returns `${modified}:${size}` for an existing file', async () => {
    state.files.set('/file.txt', {
      data: new Uint8Array([1, 2, 3, 4, 5]),
      attrs: { mtime: 1700000000 },
    })
    const res = makeResource(state)
    const fp = await res.fingerprint(spec('/file.txt'))
    expect(fp).not.toBeNull()
    const expectedModified = new Date(1700000000 * 1000).toISOString()
    expect(fp).toBe(`${expectedModified}:5`)
  })

  it('returns null for a missing file', async () => {
    const res = makeResource(state)
    const fp = await res.fingerprint(spec('/missing.txt'))
    expect(fp).toBeNull()
  })
})
