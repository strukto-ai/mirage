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

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { PROCESS_EXECUTOR, type ProcessExecutor } from '@struktoai/mirage-core/runtime/mixin'
import { RemoteSandbox } from '@struktoai/mirage-core/runtime/sandbox/base'
import { checkMountType, requireId } from '@struktoai/mirage-core/runtime/sandbox/config'
import { registerRuntime } from '@struktoai/mirage-core/runtime/table'
import type { ProcessExecution, RunResult, SandboxPipe } from '@struktoai/mirage-core/runtime/types'
import type { RuntimeOptions } from '@struktoai/mirage-core/runtime/config'
import { MICROSANDBOX_CONFIG_KEYS, type MicrosandboxConfig } from './config.ts'
import { RUNNING_STATE, MICROSANDBOX_CLI_HINT, notRunningHint } from './constants.ts'
import { type CliResult, runCli } from '../cli.ts'

/**
 * Run programs in an existing Microsandbox guest through the msb CLI.
 * The user starts the sandbox and serves its workspace at the same paths
 * inside the guest. Mirage forwards commands, stdin, environment, and cwd
 * without managing the sandbox's lifecycle.
 */
export class MicrosandboxRuntime
  extends RemoteSandbox<MicrosandboxConfig>
  implements ProcessExecutor
{
  readonly [PROCESS_EXECUTOR] = true as const
  readonly name = 'microsandbox'

  constructor(options: RuntimeOptions<MicrosandboxConfig> | Record<string, unknown> = {}) {
    super(options, MICROSANDBOX_CONFIG_KEYS)
    requireId('microsandbox', 'sandbox', this.config.sandbox)
    this.serveMounts(checkMountType('microsandbox', this.config.mountType))
  }

  // One msb CLI invocation.
  protected microsandbox(
    args: string[],
    stdin: Uint8Array | null = null,
    signal?: AbortSignal,
  ): Promise<CliResult> {
    return runCli('msb', MICROSANDBOX_CLI_HINT, args, stdin, signal !== undefined ? { signal } : {})
  }

  /** Require a running sandbox before executing any commands. */
  async connect(): Promise<void> {
    const result = await this.microsandbox(['inspect', this.config.sandbox, '--format', 'json'])
    if (result.code !== 0) {
      throw new Error(`msb inspect failed: ${DECODER.decode(result.stderr).trim()}`)
    }
    let status: unknown
    try {
      status = JSON.parse(DECODER.decode(result.stdout))
    } catch (error) {
      throw new Error(`msb inspect returned unreadable json: ${String(error)}`)
    }
    if (status === null || typeof status !== 'object' || Array.isArray(status)) {
      throw new Error('msb inspect returned an invalid status object')
    }
    const state = (status as { status?: unknown }).status
    if (state !== RUNNING_STATE) {
      throw new Error(notRunningHint(this.config.sandbox, String(state)))
    }
  }

  async execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    return this.execArgv(['sh', '-c', line], stdin, env, cwd, signal)
  }

  async runProcess(request: ProcessExecution): Promise<RunResult> {
    await this.ensureConnected(request.signal)
    const refusal = await this.admitMounts(request.signal)
    if (refusal !== null) return refusal
    return this.execArgv(
      request.argv,
      request.stdin,
      { ...this.config.env, ...request.env },
      request.cwd.virtual,
      request.signal,
    )
  }

  private async execArgv(
    argv: readonly string[],
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const args = ['exec', this.config.sandbox, '--quiet', '--no-tty', '-w', cwd]
    for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`)
    // `--` ends the flags: the command is a trailing var arg, so a
    // line starting with a dash would otherwise parse as one.
    args.push('--', ...argv)
    const result = await this.microsandbox(args, stdin, signal)
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code }
  }

  override async openPipe(command: string): Promise<SandboxPipe> {
    const child = spawn(
      'msb',
      ['exec', this.config.sandbox, '--quiet', '--no-tty', '--stream', '--', 'sh', '-c', command],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    )
    child.stdin.on('error', (err) => {
      console.debug(`microsandbox: the pipe for ${command} closed`, err)
    })
    const exited = once(child, 'close').catch((err: unknown) => {
      console.debug('microsandbox: the mount pipe did not start', err)
    })
    try {
      await once(child, 'spawn')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(MICROSANDBOX_CLI_HINT)
      throw err
    }
    return {
      reader: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      writer: child.stdin,
      stop: async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill()
        await exited
      },
    }
  }
}

const DECODER = new TextDecoder()

registerRuntime('microsandbox', MicrosandboxRuntime)
