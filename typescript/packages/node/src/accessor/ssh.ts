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
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2'
import { Accessor } from '@struktoai/mirage-core/accessor/index'
import { connectOptions } from '../utils/ssh.ts'
import type { SSHConfig } from '../vfs/ssh/config.ts'

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
    const opts = await connectOptions(
      this.config.host,
      this.config.hostname,
      this.config.port,
      this.config.username,
      this.config.identityFile,
      this.config.timeout ?? 30,
      this.config.password,
      this.config.passphrase,
    )
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
      // A connection the server or the network ends leaves its SFTP channel
      // dead, so it is dropped and the next call connects afresh.
      c.on('close', () => {
        if (this.client === c) {
          this.client = null
          this.sftpClient = null
        }
      })
      c.connect(opts)
    })
  }

  /**
   * Run `command` on the server over the mount's connection: its exit status
   * (null when a signal ended it), its output and its error output. Mirrors
   * Python's `run`.
   */
  async run(command: string): Promise<[number | null, Uint8Array, Uint8Array]> {
    await this.sftp()
    const client = this.client
    if (client === null) throw new Error('the ssh connection closed')
    return new Promise((resolveFn, rejectFn) => {
      client.exec(command, (err, channel) => {
        if (err !== undefined) {
          rejectFn(err)
          return
        }
        const chunks: Buffer[] = []
        const errors: Buffer[] = []
        let status: number | null = null
        channel.on('data', (chunk: Buffer) => chunks.push(chunk))
        channel.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
        channel.on('exit', (code: number | null) => {
          status = code
        })
        channel.on('error', rejectFn)
        channel.on('close', () => {
          resolveFn([
            status,
            new Uint8Array(Buffer.concat(chunks)),
            new Uint8Array(Buffer.concat(errors)),
          ])
        })
      })
    })
  }

  /**
   * Run `command` on the server over the mount's connection and yield its
   * output as it arrives, its standard input closed and its error output
   * discarded. An iterator rather than a generator: a generator queues
   * `return` behind a pull waiting for output, so a quiet command could never
   * be closed; `return` here closes the command's channel at once, a pull in
   * flight or a channel still opening included. Once `limit` unread bytes are
   * held the channel pauses until the reader drains them, so a slow reader
   * holds back the server rather than filling memory. Mirrors Python's
   * `run_stream`, where each read pulls from asyncssh's own bounded buffer.
   */
  runStream(command: string, limit = 1 << 20): AsyncIterableIterator<Uint8Array> {
    const chunks: Uint8Array[] = []
    let held = 0
    const done: IteratorResult<Uint8Array> = { value: undefined, done: true }
    let channel: ClientChannel | null = null
    let opening: Promise<void> | null = null
    let ended = false
    let failure: Error | null = null
    let wake: (() => void) | null = null
    const notify = (): void => {
      const resume = wake
      wake = null
      resume?.()
    }
    const open = async (): Promise<void> => {
      await this.sftp()
      const client = this.client
      if (client === null) throw new Error('the ssh connection closed')
      const opened = await new Promise<ClientChannel>((resolveFn, rejectFn) => {
        client.exec(command, (err, made) => {
          if (err !== undefined) rejectFn(err)
          else resolveFn(made)
        })
      })
      if (ended) {
        opened.close()
        return
      }
      channel = opened
      opened.stderr.resume()
      opened.on('data', (chunk: Buffer) => {
        chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
        held += chunk.byteLength
        if (held >= limit) opened.pause()
        notify()
      })
      opened.on('error', (err: unknown) => {
        failure = err instanceof Error ? err : new Error(String(err))
        ended = true
        notify()
      })
      opened.on('close', () => {
        ended = true
        notify()
      })
      opened.end()
    }
    return {
      async next(): Promise<IteratorResult<Uint8Array>> {
        opening ??= open()
        await opening
        while (chunks.length === 0 && !ended) {
          await new Promise<void>((resolveFn) => {
            wake = resolveFn
          })
        }
        const value = chunks.shift()
        if (value !== undefined) {
          held -= value.byteLength
          if (held < limit && channel?.isPaused() === true) channel.resume()
          return { value, done: false }
        }
        if (failure !== null) throw failure
        return done
      },
      return(): Promise<IteratorResult<Uint8Array>> {
        ended = true
        chunks.length = 0
        held = 0
        channel?.close()
        notify()
        return Promise.resolve(done)
      },
      [Symbol.asyncIterator]() {
        return this
      },
    }
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
