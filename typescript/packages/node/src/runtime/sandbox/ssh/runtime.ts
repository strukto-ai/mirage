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

import { constants } from 'node:os'
import { Readable } from 'node:stream'
import { once } from 'node:events'
import { connectOptions } from '../../../utils/ssh.ts'
import { RemoteSandbox } from '@struktoai/mirage-core/runtime/sandbox/base'
import { requireId } from '@struktoai/mirage-core/runtime/sandbox/config'
import { registerRuntime } from '@struktoai/mirage-core/runtime/table'
import type { RunResult, SandboxPipe } from '@struktoai/mirage-core/runtime/types'
import type { RuntimeOptions } from '@struktoai/mirage-core/runtime/config'
import { loadSdk, type Ssh2Sdk } from './sdk.ts'
import { SSH_RUNTIME_CONFIG_KEYS, type SSHRuntimeConfig } from './config.ts'
import { wrapLine } from '@struktoai/mirage-core/runtime/sandbox/constants'
import type { CliResult } from '../cli.ts'
import { makeAbortError } from '@struktoai/mirage-core/utils/abort'
import type { Client, ClientChannel } from 'ssh2'

/**
 * A machine reached over SSH as a whole-line runtime.
 *
 * You run the machine and its sshd yourself; mirage only connects
 * (keys or an agent, never a password) and execs lines. One connection opens on
 * the first captured line and is reused; each line is one exec
 * channel with real byte stdin and separated stderr, the merged
 * environment and session cwd dressed onto the command by wrapLine,
 * because SSH exec has no docker-style `-w`/`-e`.
 *
 * This is the one provider whose machine usually IS the fileserver:
 * mount the same host's directory over the ssh VFS at a prefix
 * equal to its remote absolute path, and captured lines read and
 * write those files natively, with no FUSE and no mirage installed
 * remotely. Host keys are not verified (ssh2 never does), so treat
 * the network path as trusted.
 */
export class SSHRuntime extends RemoteSandbox<SSHRuntimeConfig> {
  readonly name = 'ssh'
  private client: Client | null = null

  constructor(options: RuntimeOptions<SSHRuntimeConfig> = {}) {
    super(options, SSH_RUNTIME_CONFIG_KEYS)
    requireId('ssh', 'host', this.config.host)
  }

  // The SDK loader as a seam: tests substitute a fake module here.
  protected loadSdk(): Promise<Ssh2Sdk> {
    return loadSdk()
  }

  async connect(): Promise<void> {
    const sdk = await this.loadSdk()
    const client = new sdk.Client()
    const opts = await connectOptions(
      this.config.host,
      this.config.hostname,
      this.config.port,
      this.config.username,
      this.config.identityFile,
      this.config.timeout ?? 30,
    )
    await new Promise<void>((resolveFn, rejectFn) => {
      client.on('ready', () => {
        // A mount_type's SFTP rides this connection, which stalls on
        // Nagle as the SSH accessor's did (accessor/ssh.ts).
        client.setNoDelay(true)
        resolveFn()
      })
      client.on('error', rejectFn)
      client.on('close', () => {
        if (this.client === client) {
          this.client = null
          this.disconnected()
        }
      })
      client.connect(opts)
    })
    this.client = client
  }

  override async execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const result = await this.ssh(wrapLine(line, env, cwd), stdin, signal)
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code }
  }

  /**
   * One exec channel on the shared connection; the seam tests override. An
   * abort signals the command and closes its channel, so a line abandoned
   * to a timeout neither waits for the remote side nor leaves the channel
   * open, which sshd counts against its sessions per connection.
   */
  protected ssh(
    command: string,
    stdin: Uint8Array | null,
    signal?: AbortSignal,
  ): Promise<CliResult> {
    const client = this.client
    if (client === null) return Promise.reject(new Error('ssh runtime not connected'))
    return new Promise((resolveFn, rejectFn) => {
      client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err !== undefined) {
          rejectFn(err)
          return
        }
        const abort = (): void => {
          stream.signal('KILL')
          stream.close()
          rejectFn(makeAbortError(signal))
        }
        if (signal?.aborted === true) {
          abort()
          return
        }
        signal?.addEventListener('abort', abort, { once: true })
        const out: Buffer[] = []
        const errs: Buffer[] = []
        let code: number | null = null
        stream.on('data', (chunk: Buffer) => out.push(chunk))
        stream.stderr.on('data', (chunk: Buffer) => errs.push(chunk))
        stream.on('exit', (c: number | null, signalName?: string) => {
          code =
            c ??
            (signalName
              ? 128 + constants.signals[`SIG${signalName.replace(/^SIG/, '')}` as NodeJS.Signals]
              : 1)
        })
        stream.on('close', () => {
          signal?.removeEventListener('abort', abort)
          resolveFn({
            stdout: new Uint8Array(Buffer.concat(out)),
            stderr: new Uint8Array(Buffer.concat(errs)),
            code: code ?? 1,
          })
        })
        stream.on('error', (streamErr: Error) => {
          signal?.removeEventListener('abort', abort)
          stream.close()
          rejectFn(streamErr)
        })
        // No pipe still closes stdin, so a reader sees EOF immediately.
        if (stdin !== null) stream.write(stdin)
        stream.end()
      })
    })
  }

  override openPipe(command: string): Promise<SandboxPipe> {
    const client = this.client
    if (client === null) return Promise.reject(new Error('ssh runtime not connected'))
    return new Promise((resolve, reject) => {
      client.exec(command, (error: Error | undefined, stream: ClientChannel) => {
        if (error !== undefined) {
          reject(error)
          return
        }
        stream.stderr.resume()
        const exited = once(stream, 'close').catch((err: unknown) => {
          console.debug('ssh helper closed', err)
        })
        resolve({
          reader: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
          writer: stream,
          stop: async () => {
            stream.close()
            await exited
          },
        })
      })
    })
  }

  override async close(): Promise<void> {
    await super.close()
    this.disconnected()
    if (this.client !== null) {
      this.client.end()
      this.client = null
    }
  }
}

registerRuntime('ssh', SSHRuntime)
