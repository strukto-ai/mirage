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

import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '@struktoai/mirage-node'
import type { Client } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bindKey,
  closeHarnesses,
  connect,
  exec,
  sshSessions,
  startHarness,
  vaultWorkspace,
} from './harness.ts'
import { loginEnv } from './login.ts'

afterEach(closeHarnesses)

describe('loginEnv', () => {
  it('is what sshd hands a login', () => {
    const request = {
      username: 'demo',
      profile: [],
      account: [],
      command: null,
      term: 'xterm-256color',
      env: {},
      peer: { address: '10.0.0.5', port: 40000 },
      local: { address: '10.0.0.1', port: 2222 },
      gone: new AbortController().signal,
    }
    expect(loginEnv(request)).toEqual({
      USER: 'demo',
      LOGNAME: 'demo',
      SSH_CLIENT: '10.0.0.5 40000 2222',
      SSH_CONNECTION: '10.0.0.5 40000 10.0.0.1 2222',
      TERM: 'xterm-256color',
    })
    expect(loginEnv({ ...request, term: null })).not.toHaveProperty('TERM')
  })
})

describe('logins', () => {
  it('are refused while the server shuts down', async () => {
    const h = await startHarness()
    h.registry.draining = true
    const run = await exec(await connect(h), 'echo never')
    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('server is shutting down')
  })

  it('are refused past max_sessions', async () => {
    const h = await startHarness()
    Object.assign(h.registry, { maxSessions: 1 })
    const run = await exec(await connect(h), 'echo never')
    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('workspace is at max_sessions (1)')
  })

  it('carry the login environment', async () => {
    const client = await connect(await startHarness())
    const fresh = await exec(client, 'echo "$HOME $USER $LOGNAME"; cd; pwd')
    expect([fresh.stdout, fresh.stderr]).toEqual([
      '/root demo demo\n/\n',
      'bash: line 1: cd: /root: No such file or directory\n',
    ])
    expect((await exec(client, 'mkdir -p /root; cd; pwd')).stdout).toBe('/root\n')
  })

  it('keep a value the profile set over the login default', async () => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      { mode: MountMode.WRITE, profiles: { agent: { env: { HOME: '/work' } } }, profile: 'agent' },
    )
    const client = await connect(await startHarness(ws))
    expect((await exec(client, 'echo "$HOME $USER"')).stdout).toBe('/work demo\n')
  })

  it('refuse an unknown workspace by name', async () => {
    const client = await connect(await startHarness(), 'nope')
    expect(await exec(client, 'echo hi')).toEqual({
      stdout: '',
      stderr: 'mirage: no such workspace: nope\n',
      code: 1,
    })
  })
})

it('closes sessions when login environment setup fails', async () => {
  const h = await startHarness()
  const spy = vi
    .spyOn(h.entry.runner.ws, 'shell')
    .mockRejectedValue(new Error('login export failed'))
  try {
    const client = await connect(h)
    for (let i = 0; i < 2; i++) {
      const result = await exec(client, 'echo never')
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('login export failed')
      expect(sshSessions(h)).toEqual([])
    }
  } finally {
    spy.mockRestore()
  }
})

describe('key profiles', () => {
  it('run a key bound to a profile under it', async () => {
    const h = await startHarness(await vaultWorkspace())
    const guarded = bindKey(h, 'mirage-profile="guarded"')
    const unsealed = await exec(await connect(h), 'cat /vault/secret')
    const sealed = await exec(await connect(h, 'demo', guarded), 'cat /vault/secret')
    expect(unsealed.stdout).toBe('token\n')
    expect(sealed.code).toBe(126)
    expect(sealed.stderr).toContain('the vault is sealed')
  })

  it.each([
    ['mirage-profile="nope"', 'nope'],
    ['mirage-profile="a",mirage-profile="b"', 'exactly one profile'],
    ['mirage-profile=""', 'exactly one profile'],
    ['mirage-profile', 'exactly one profile'],
  ])('refuse a key carrying %s', async (options, reason) => {
    const h = await startHarness(await vaultWorkspace())
    const bad = bindKey(h, options)
    const run = await exec(await connect(h, 'demo', bad), 'echo never')
    expect(run.code).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('cannot open a session')
    expect(run.stderr).toContain(reason)
  })
})

describe('key accounts', () => {
  /** The error a fresh SFTP channel answers its first listing with. */
  function sftpListError(client: Client): Promise<{ code?: number }> {
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err !== undefined) {
          reject(err)
          return
        }
        sftp.readdir('/', (listErr) => {
          resolve((listErr ?? {}) as { code?: number })
        })
      })
    })
  }

  it('open only the workspaces the account owns', async () => {
    const h = await startHarness()
    h.registry.add(new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }), 'mine', 'alice')
    const alice = bindKey(h, 'mirage-account="alice"')
    const own = await exec(await connect(h, 'mine', alice), 'echo mine')
    const otherClient = await connect(h, 'demo', alice)
    const other = await exec(otherClient, 'echo never')
    const listing = await sftpListError(otherClient)
    const admin = await exec(await connect(h, 'mine'), 'echo admin')
    expect(own.stdout).toBe('mine\n')
    expect(other).toEqual({ stdout: '', stderr: 'mirage: no such workspace: demo\n', code: 1 })
    expect(listing.code).toBe(2)
    expect(admin.stdout).toBe('admin\n')
  })

  it('refuse a key without one when accounts are required', async () => {
    const h = await startHarness()
    h.registry.accountsRequired = true
    expect(await exec(await connect(h), 'echo never')).toEqual({
      stdout: '',
      stderr: 'mirage: no such workspace: demo\n',
      code: 1,
    })
  })
})
