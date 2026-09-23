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

import { readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { resolve } from 'node:path'
import { RemoteSandbox } from '@struktoai/mirage-core/runtime/sandbox/base'
import { registerRuntime } from '@struktoai/mirage-core/runtime/table'
import type { RunResult, RuntimeOptions } from '@struktoai/mirage-core/runtime/types'
import { loadOptionalPeer } from '@struktoai/mirage-core/utils/optional_peer'
import { SSH_RUNTIME_CONFIG_KEYS, type SSHRuntimeConfig } from './config.ts'
import { wrapLine } from './constants.ts'
import type { Client, ClientChannel, ConnectConfig } from 'ssh2'
import type * as Ssh2Mod from 'ssh2'

export type Ssh2Sdk = typeof Ssh2Mod

interface SshResult {
  stdout: Uint8Array
  stderr: Uint8Array
  code: number
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2))
  return p
}

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

  constructor(options: RuntimeOptions<SSHRuntimeConfig> | Record<string, unknown> = {}) {
    super(options, SSH_RUNTIME_CONFIG_KEYS)
    if (!this.config.host) {
      throw new Error('ssh config needs host: the machine that runs captured lines')
    }
  }

  // The SDK loader as a seam: tests substitute a fake module here.
  protected loadSdk(): Promise<Ssh2Sdk> {
    return loadOptionalPeer(() => import('ssh2'), {
      feature: "the 'ssh' runtime",
      packageName: 'ssh2',
    })
  }

  private async connectOpts(): Promise<ConnectConfig> {
    const opts: ConnectConfig = {
      host: this.config.hostname ?? this.config.host,
      port: this.config.port ?? 22,
      username: this.config.username ?? userInfo().username,
      readyTimeout: (this.config.timeout ?? 30) * 1000,
    }
    if (this.config.identityFile !== undefined) {
      opts.privateKey = await readFile(expandHome(this.config.identityFile))
    } else if (process.env.SSH_AUTH_SOCK) {
      // The asyncssh twin's rule: a named key is used alone; with
      // none, the ssh-agent authenticates.
      opts.agent = process.env.SSH_AUTH_SOCK
    }
    return opts
  }

  async connect(): Promise<void> {
    const sdk = await this.loadSdk()
    const client = new sdk.Client()
    const opts = await this.connectOpts()
    await new Promise<void>((resolveFn, rejectFn) => {
      client.on('ready', () => {
        resolveFn()
      })
      client.on('error', rejectFn)
      client.connect(opts)
    })
    this.client = client
  }

  async execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult> {
    const result = await this.ssh(wrapLine(line, env, cwd), stdin)
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code }
  }

  // One exec channel on the shared connection; the seam tests override.
  protected ssh(command: string, stdin: Uint8Array | null): Promise<SshResult> {
    const client = this.client
    if (client === null) return Promise.reject(new Error('ssh runtime not connected'))
    return new Promise((resolveFn, rejectFn) => {
      client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err !== undefined) {
          rejectFn(err)
          return
        }
        const out: Buffer[] = []
        const errs: Buffer[] = []
        let code: number | null = null
        stream.on('data', (chunk: Buffer) => out.push(chunk))
        stream.stderr.on('data', (chunk: Buffer) => errs.push(chunk))
        stream.on('exit', (c: number | null) => {
          code = c
        })
        stream.on('close', () => {
          resolveFn({
            stdout: new Uint8Array(Buffer.concat(out)),
            stderr: new Uint8Array(Buffer.concat(errs)),
            code: code ?? 1,
          })
        })
        stream.on('error', rejectFn)
        // No pipe still closes stdin, so a reader sees EOF immediately.
        if (stdin !== null) stream.write(stdin)
        stream.end()
      })
    })
  }

  override close(): Promise<void> {
    if (this.client !== null) {
      this.client.end()
      this.client = null
    }
    return Promise.resolve()
  }
}

registerRuntime('ssh', SSHRuntime)
