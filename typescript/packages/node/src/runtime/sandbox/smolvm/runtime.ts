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
import { PROCESS_EXECUTOR, type ProcessExecutor } from '@struktoai/mirage-core/runtime/mixin'
import { RemoteSandbox } from '@struktoai/mirage-core/runtime/sandbox/base'
import { registerRuntime } from '@struktoai/mirage-core/runtime/table'
import type {
  ProcessExecution,
  RunResult,
  RuntimeOptions,
} from '@struktoai/mirage-core/runtime/types'
import { SMOLVM_CONFIG_KEYS, type SmolvmConfig } from './config.ts'
import { RUNNING_STATE, SMOLVM_CLI_HINT, notRunningHint } from './constants.ts'

interface SmolvmResult {
  stdout: Uint8Array
  stderr: Uint8Array
  code: number
}

/**
 * A microVM the user runs as a whole-line runtime.
 *
 * You start the machine yourself; mirage only connects to it and
 * execs lines. The smolvm CLI is the transport, so there is no SDK
 * dependency and no daemon socket wiring; each line is one `smolvm
 * machine exec` with the merged environment, the rebased cwd, real
 * stdin, and separated stderr.
 *
 * Unlike a container, the guest runs its own kernel, so the line sees
 * that kernel's filesystem and nothing of the host's except what the
 * machine was given at boot (`--volume`). Serve the workspace inside
 * the guest at the host's mount prefixes, the same contract every
 * provider in this family carries.
 */
export class SmolvmRuntime extends RemoteSandbox<SmolvmConfig> implements ProcessExecutor {
  readonly [PROCESS_EXECUTOR] = true as const
  readonly name = 'smolvm'

  constructor(options: RuntimeOptions<SmolvmConfig> | Record<string, unknown> = {}) {
    super(options, SMOLVM_CONFIG_KEYS)
    if (!this.config.machine) {
      throw new Error('smolvm config needs machine: the name of a running machine')
    }
  }

  // One smolvm CLI invocation; the seam tests override.
  protected smolvm(
    args: string[],
    stdin: Uint8Array | null = null,
    signal?: AbortSignal,
  ): Promise<SmolvmResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('smolvm', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        signal,
        killSignal: 'SIGKILL',
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
      child.on('error', (error: NodeJS.ErrnoException) => {
        reject(error.code === 'ENOENT' ? new Error(SMOLVM_CLI_HINT) : error)
      })
      child.on('close', (code) => {
        resolve({
          stdout: new Uint8Array(Buffer.concat(out)),
          stderr: new Uint8Array(Buffer.concat(err)),
          code: code ?? 1,
        })
      })
      // EPIPE means the guest command exited without draining its
      // stdin (`head`-like); python's communicate() suppresses the
      // matching BrokenPipeError, so it is not an error here either.
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') reject(error)
      })
      if (stdin !== null) child.stdin.write(stdin)
      child.stdin.end()
    })
  }

  /**
   * Probe the machine, refusing any state that cannot take a line.
   *
   * `machine exec` would start a stopped machine on its own, but this
   * family never manages sandbox lifecycle, so a machine that is not
   * already running is an error rather than a boot.
   */
  async connect(): Promise<void> {
    const result = await this.smolvm(['machine', 'status', '--name', this.config.machine, '--json'])
    if (result.code !== 0) {
      throw new Error(`smolvm machine status failed: ${decode(result.stderr).trim()}`)
    }
    let status: { state?: unknown }
    try {
      status = JSON.parse(decode(result.stdout)) as { state?: unknown }
    } catch (error) {
      throw new Error(`smolvm machine status returned unreadable json: ${String(error)}`)
    }
    if (status.state !== RUNNING_STATE) {
      throw new Error(notRunningHint(this.config.machine, String(status.state)))
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
    if (request.argv.length === 0) throw new Error('process argv must not be empty')
    await this.ensureConnected(request.signal)
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
    const args = ['machine', 'exec', '--name', this.config.machine, '-i', '-w', cwd]
    for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`)
    // `--` ends the flags: the command is a trailing var arg, so a
    // line starting with a dash would otherwise parse as one.
    args.push('--', ...argv)
    const result = await this.smolvm(args, stdin, signal)
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code }
  }
}

const DECODER = new TextDecoder()

function decode(bytes: Uint8Array): string {
  return DECODER.decode(bytes)
}

registerRuntime('smolvm', SmolvmRuntime)
