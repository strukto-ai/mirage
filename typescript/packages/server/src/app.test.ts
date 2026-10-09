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
import ssh2 from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RAMExecutionStore } from '@struktoai/mirage-core/execution/ram'
import { buildApp } from './app.ts'
import { DaemonConfigError } from './daemon_config.ts'
import type { SSHConfig } from './ssh/config.ts'
import { mintKeyPair } from './ssh/keys.ts'

it('borrows an injected execution store', async () => {
  const store = new RAMExecutionStore()
  const app = buildApp({ executionStore: store })
  expect(app.jobs.store).toBe(store)
  await app.ready()
  expect(await store.list()).toEqual([])
  await app.close()
  expect(await store.list()).toEqual([])
  await store.close()
})

describe('buildApp pid file wiring', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('explicit pidFile option wins over home', async () => {
    vi.stubEnv('MIRAGE_HOME', '/data/mirage')
    const app = buildApp({ pidFile: '/x/y.pid' })
    expect(app.pidFile).toBe('/x/y.pid')
    await app.close()
  })

  it('defaults under MIRAGE_HOME', async () => {
    vi.stubEnv('MIRAGE_HOME', '/data/mirage')
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
    expect(() => buildApp()).toThrow(DaemonConfigError)
    expect(() => buildApp()).toThrow(/typo_key/)
  })

  it('accepts a valid config.toml', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mir-app-'))
    writeFileSync(join(home, 'config.toml'), '[daemon]\nurl = "http://h:1"\n')
    vi.stubEnv('MIRAGE_HOME', home)
    const app = buildApp()
    await app.close()
  })
})

describe('buildApp ssh door', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.doUnmock('ssh2')
  })

  function sshConfigIn(dir: string, publicKey: string): SSHConfig {
    writeFileSync(join(dir, 'authorized_keys'), `${publicKey}\n`)
    return {
      port: 0,
      host: '127.0.0.1',
      hostKeyFile: join(dir, 'host_key'),
      authorizedKeysFile: join(dir, 'authorized_keys'),
    }
  }

  it('stays shut by default', async () => {
    vi.stubEnv('MIRAGE_HOME', mkdtempSync(join(tmpdir(), 'mir-app-')))
    vi.stubEnv('MIRAGE_SSH_PORT', '')
    const app = buildApp()
    await app.ready()
    expect(app.ssh.config.port).toBeNull()
    expect(app.ssh.listener).toBeNull()
    await app.close()
  })

  it('serves a workspace made over HTTP, and closes with the app', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mir-app-'))
    const pair = mintKeyPair(ssh2.utils)
    const app = buildApp({
      pidFile: join(dir, 'daemon.pid'),
      sshConfig: sshConfigIn(dir, pair.public),
    })
    await app.ready()
    const port = app.ssh.listener?.port ?? 0
    const created = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { config: { mounts: { '/': { vfs: 'ram', mode: 'WRITE' } } } },
    })
    const wid = created.json<{ id: string }>().id
    const out = await sshExec(port, wid, pair.private, 'echo over-ssh > /f && cat /f')
    const viaHttp = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${wid}/shell`,
      payload: { command: 'cat /f' },
    })
    expect(out).toBe('over-ssh\n')
    expect(viaHttp.json<{ stdout: string }>().stdout).toBe('over-ssh\n')
    await app.close()
    await expect(sshExec(port, wid, pair.private, 'true')).rejects.toThrow()
  })

  it('fails the start when ssh2 is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mir-app-'))
    vi.doMock('ssh2', () => {
      throw new Error("Cannot find package 'ssh2'")
    })
    const app = buildApp({ pidFile: join(dir, 'daemon.pid'), sshConfig: sshConfigIn(dir, 'x') })
    await expect(app.ready()).rejects.toThrow(/needs ssh2/)
  })
})

function sshExec(
  port: number,
  username: string,
  privateKey: string,
  command: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client()
    client.on('error', reject)
    client.on('ready', () => {
      client.exec(command, (err, stream) => {
        if (err !== undefined) {
          reject(err)
          return
        }
        let out = ''
        stream.on('data', (d: Buffer) => {
          out += d.toString()
        })
        stream.on('close', () => {
          client.end()
          resolve(out)
        })
      })
    })
    client.connect({ host: '127.0.0.1', port, username, privateKey })
  })
}
