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

import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '@struktoai/mirage-node'
import ssh2, { type Client, type ConnectConfig } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceRegistry } from '../registry.ts'
import type { SSHConfig } from './config.ts'
import { mintKeyPair } from './keys.ts'
import { readAuthorizedKeys, startSSHServer } from './server.ts'
import type { SSHListener } from './types.ts'

const listeners: SSHListener[] = []
const clients: Client[] = []

function configIn(dir: string): SSHConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    hostKeyFile: join(dir, 'host_key'),
    authorizedKeysFile: join(dir, 'authorized_keys'),
  }
}

async function start(config: SSHConfig): Promise<SSHListener> {
  const registry = new WorkspaceRegistry({ idleGraceSeconds: 0 })
  registry.add(new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }), 'demo')
  const listener = await startSSHServer(registry, config)
  listeners.push(listener)
  return listener
}

function login(listener: SSHListener, auth: Partial<ConnectConfig>): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client()
    clients.push(client)
    client.on('ready', () => {
      resolve(client)
    })
    client.on('error', reject)
    client.connect({ host: '127.0.0.1', port: listener.port, username: 'demo', ...auth })
  })
}

function echo(client: Client, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(`echo ${text}`, (err, stream) => {
      if (err !== undefined) {
        reject(err)
        return
      }
      let out = ''
      stream.on('data', (d: Buffer) => {
        out += d.toString()
      })
      stream.on('close', () => {
        resolve(out)
      })
    })
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.doUnmock('ssh2')
  for (const client of clients.splice(0)) client.end()
  for (const listener of listeners.splice(0)) await listener.close()
})

describe('startSSHServer', () => {
  it('admits an authorized key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ssh-server-'))
    const pair = mintKeyPair(ssh2.utils)
    writeFileSync(join(dir, 'authorized_keys'), `${pair.public}\n`)
    const client = await login(await start(configIn(dir)), { privateKey: pair.private })
    expect(await echo(client, 'in')).toBe('in\n')
  })

  it('loads ssh2 as Node does, with Server and utils only on its default export', async () => {
    vi.doMock('ssh2', () => ({ default: ssh2, Client: ssh2.Client }))
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ssh-server-'))
    const pair = mintKeyPair(ssh2.utils)
    writeFileSync(join(dir, 'authorized_keys'), `${pair.public}\n`)
    const client = await login(await start(configIn(dir)), { privateKey: pair.private })
    expect(await echo(client, 'in')).toBe('in\n')
  })

  it('refuses agent forwarding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ssh-server-'))
    const pair = mintKeyPair(ssh2.utils)
    writeFileSync(join(dir, 'authorized_keys'), `${pair.public}\n`)
    const client = await login(await start(configIn(dir)), {
      privateKey: pair.private,
      agent: join(dir, 'agent'),
      agentForward: true,
    })
    await expect(echo(client, 'in')).rejects.toThrow(/Unable to request agent forwarding/)
  })

  it('refuses a stranger key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ssh-server-'))
    writeFileSync(join(dir, 'authorized_keys'), `${mintKeyPair(ssh2.utils).public}\n`)
    const stranger = mintKeyPair(ssh2.utils)
    await expect(
      login(await start(configIn(dir)), { privateKey: stranger.private }),
    ).rejects.toThrow(/authentication methods failed/)
  })

  it('admits a key added later without a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ssh-server-'))
    writeFileSync(join(dir, 'authorized_keys'), '')
    const listener = await start(configIn(dir))
    const late = mintKeyPair(ssh2.utils)
    await expect(login(listener, { privateKey: late.private })).rejects.toThrow()
    appendFileSync(join(dir, 'authorized_keys'), `${late.public}\n`)
    const client = await login(listener, { privateKey: late.private })
    expect(await echo(client, 'late')).toBe('late\n')
  })

  it('never offers passwords', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ssh-server-'))
    writeFileSync(join(dir, 'authorized_keys'), '')
    await expect(login(await start(configIn(dir)), { password: 'anything' })).rejects.toThrow(
      /authentication methods failed/,
    )
  })

  it('keeps its host key across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ssh-server-'))
    await (await start(configIn(dir))).close()
    const minted = readFileSync(join(dir, 'host_key'), 'utf-8')
    await start(configIn(dir))
    expect(readFileSync(join(dir, 'host_key'), 'utf-8')).toBe(minted)
  })

  it('warns and refuses logins without an authorized keys file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ssh-server-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const listener = await start({ ...configIn(dir), authorizedKeysFile: join(dir, 'absent') })
    expect(warn.mock.calls.flat().join('\n')).toContain('every login will be refused')
    const key = mintKeyPair(ssh2.utils)
    await expect(login(listener, { privateKey: key.private })).rejects.toThrow()
  })
})

describe('readAuthorizedKeys', () => {
  it('skips comments, blanks and lines carrying options it does not read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ssh-server-'))
    const good = mintKeyPair(ssh2.utils)
    const optioned = mintKeyPair(ssh2.utils)
    const mixed = mintKeyPair(ssh2.utils)
    const file = join(dir, 'authorized_keys')
    writeFileSync(
      file,
      `# a comment\n\n${good.public}\ncommand="/bin/false" ${optioned.public}\n` +
        `mirage-profile="guarded",no-pty ${mixed.public}\n`,
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const keys = await readAuthorizedKeys(file, ssh2.utils)
    expect(keys.map((k) => k.profile)).toEqual([[]])
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('reads the mirage-profile option off its key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ssh-server-'))
    const bound = mintKeyPair(ssh2.utils)
    const quoted = mintKeyPair(ssh2.utils)
    const file = join(dir, 'authorized_keys')
    writeFileSync(
      file,
      `mirage-profile="guarded" ${bound.public}\nMIRAGE-PROFILE="a \\"b\\"" ${quoted.public}\n`,
    )
    const keys = await readAuthorizedKeys(file, ssh2.utils)
    expect(keys.map((k) => k.profile)).toEqual([['guarded'], ['a "b"']])
  })
})
