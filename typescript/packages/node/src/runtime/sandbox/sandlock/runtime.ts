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

import { EXTERNAL_COMMANDS } from '@struktoai/mirage-core/runtime/constants'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { PathSpec } from '@struktoai/mirage-core/types'
import { Runtime } from '@struktoai/mirage-core/runtime/base'
import {
  LINE_EXECUTOR,
  PROCESS_EXECUTOR,
  type LineExecutor,
  type ProcessExecutor,
} from '@struktoai/mirage-core/runtime/mixin'
import { registerRuntime } from '@struktoai/mirage-core/runtime/table'
import type {
  ProcessExecution,
  RunResult,
  RuntimeOptions,
} from '@struktoai/mirage-core/runtime/types'
import { SANDLOCK_CONFIG_KEYS, type SandlockConfig } from './config.ts'
import { SANDLOCK_CLI_HINT, SYSTEM_READABLE } from './constants.ts'

/** Native commands confined by Sandlock; workspace access needs a granted native mount. */
export class SandlockRuntime extends Runtime implements LineExecutor, ProcessExecutor {
  readonly name = 'sandlock'
  readonly [LINE_EXECUTOR] = true as const
  readonly [PROCESS_EXECUTOR] = true as const
  declare config: SandlockConfig
  private readonly children = new Set<ChildProcess>()

  constructor(options: RuntimeOptions<SandlockConfig> = {}) {
    super(options, [EXTERNAL_COMMANDS], SANDLOCK_CONFIG_KEYS)
  }

  policyArgv(): string[] {
    const argv: string[] = []
    for (const path of [...SYSTEM_READABLE.filter(existsSync), ...(this.config.fsReadable ?? [])])
      argv.push('-r', path)
    for (const path of this.config.fsWritable ?? []) argv.push('-w', path)
    if (this.config.maxMemory !== undefined) argv.push('-m', this.config.maxMemory)
    return argv
  }

  runLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    return this.runProcess({
      kind: 'process',
      argv: ['/bin/sh', '-c', line],
      cwd: PathSpec.fromStrPath(cwd),
      env,
      stdin,
      ...(signal ? { signal } : {}),
    })
  }

  async runProcess(request: ProcessExecution): Promise<RunResult> {
    request.signal?.throwIfAborted()
    if (request.argv.length === 0) throw new Error('process argv must not be empty')
    const argv = ['run', ...this.policyArgv(), '--clean-env']
    for (const [key, value] of Object.entries({ ...this.config.env, ...request.env }))
      argv.push('--env', `${key}=${value}`)
    argv.push('--', ...request.argv)
    return new Promise((resolve, reject) => {
      // Only host PATH locates the CLI; requested variables go to the confined child.
      const child = spawn('sandlock', argv, {
        cwd: request.cwd.virtual,
        env: { PATH: process.env.PATH },
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: request.signal,
        killSignal: 'SIGKILL',
      })
      this.children.add(child)
      const out: Buffer[] = []
      const err: Buffer[] = []
      let failure: Error | undefined
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
      child.on('error', (error: NodeJS.ErrnoException) => {
        failure = error.code === 'ENOENT' ? new Error(SANDLOCK_CLI_HINT) : error
      })
      child.on('close', (code) => {
        this.children.delete(child)
        if (failure !== undefined) {
          reject(failure)
          return
        }
        resolve({
          stdout: new Uint8Array(Buffer.concat(out)),
          stderr: err.length ? new Uint8Array(Buffer.concat(err)) : null,
          exitCode: code ?? 1,
        })
      })
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        // A command may finish without draining stdin, matching communicate().
        if (error.code !== 'EPIPE') {
          failure = error
          child.kill('SIGKILL')
        }
      })
      child.stdin.end(request.stdin)
    })
  }

  override async close(): Promise<void> {
    await Promise.all(
      [...this.children].map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once('close', () => {
              resolve()
            })
            child.kill('SIGKILL')
          }),
      ),
    )
  }
}

registerRuntime('sandlock', SandlockRuntime)
