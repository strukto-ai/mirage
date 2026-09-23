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

import type * as Ssh2Mod from 'ssh2'
import type { Client, SFTPWrapper } from 'ssh2'
import { Accessor } from '@struktoai/mirage-core/accessor/index'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SSHConfig } from '../vfs/ssh/config.ts'

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2))
  return p
}

export class SSHAccessor extends Accessor {
  private client: Client | null = null
  private sftpClient: SFTPWrapper | null = null
  private connectPromise: Promise<SFTPWrapper> | null = null

  constructor(public readonly config: SSHConfig) {
    super()
  }

  async sftp(): Promise<SFTPWrapper> {
    if (this.sftpClient !== null) return this.sftpClient
    if (this.connectPromise !== null) return this.connectPromise
    this.connectPromise = this.connect()
    try {
      return await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  private async connect(): Promise<SFTPWrapper> {
    let ssh2Mod: typeof Ssh2Mod
    try {
      ssh2Mod = await import('ssh2')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`ssh2 is required for the SSH VFS — install it as a peer dep: ${msg}`)
    }
    const { Client: ClientCtor } = ssh2Mod
    const c = new ClientCtor()
    const opts: Record<string, unknown> = {
      host: this.config.hostname ?? this.config.host,
      port: this.config.port ?? 22,
      readyTimeout: (this.config.timeout ?? 30) * 1000,
    }
    if (this.config.username !== undefined) opts.username = this.config.username
    if (this.config.password !== undefined) opts.password = this.config.password
    if (this.config.identityFile !== undefined) {
      opts.privateKey = readFileSync(expandHome(this.config.identityFile))
      if (this.config.passphrase !== undefined) opts.passphrase = this.config.passphrase
    }
    return new Promise<SFTPWrapper>((resolveFn, rejectFn) => {
      c.on('ready', () => {
        // SFTP is a request/response protocol over small packets, and node
        // leaves Nagle ON. Paired with Linux's 40ms delayed ACK that stalls
        // roughly every exchange, which is why the same battery costs 41.8ms
        // per case on a Linux runner and ~3ms on a BSD-derived stack. ssh2
        // offers setNoDelay but never calls it; asyncssh sets TCP_NODELAY on
        // every connection (connection.py), which is the whole reason the
        // python host was 44x faster against the same server.
        c.setNoDelay(true)
        c.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
          if (err !== undefined) {
            rejectFn(err)
            return
          }
          this.client = c
          this.sftpClient = sftp
          resolveFn(sftp)
        })
      })
      c.on('error', rejectFn)
      c.connect(opts as Parameters<Client['connect']>[0])
    })
  }

  close(): Promise<void> {
    if (this.client !== null) {
      this.client.end()
      this.client = null
      this.sftpClient = null
    }
    return Promise.resolve()
  }
}
