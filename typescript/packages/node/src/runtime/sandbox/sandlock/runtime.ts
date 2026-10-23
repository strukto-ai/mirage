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
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { Context } from '@struktoai/mirage-core/commands/config'
import { Runtime } from '@struktoai/mirage-core/runtime/base'
import {
  LINE_EXECUTOR,
  PROCESS_EXECUTOR,
  type LineExecutor,
  type ProcessExecutor,
} from '@struktoai/mirage-core/runtime/mixin'
import { registerRuntime } from '@struktoai/mirage-core/runtime/table'
import type { OutputFn, RunResult } from '@struktoai/mirage-core/runtime/types'
import type { RuntimeOptions } from '@struktoai/mirage-core/runtime/config'
import { SANDLOCK_CONFIG_KEYS, type SandlockConfig } from './config.ts'
import { SANDLOCK_CLI_HINT, SYSTEM_READABLE } from './constants.ts'
import { closeChildren, cwdRefusal, runCli } from '../cli.ts'

/** Native commands confined by Sandlock; workspace access needs a granted native mount. */
export class SandlockRuntime
  extends Runtime<undefined>
  implements LineExecutor<undefined>, ProcessExecutor<undefined>
{
  readonly name = 'sandlock'
  readonly [LINE_EXECUTOR] = true as const
  readonly [PROCESS_EXECUTOR] = true as const
  declare config: SandlockConfig
  private readonly children = new Set<ChildProcess>()

  constructor(options: RuntimeOptions<SandlockConfig> = {}) {
    super(options, [EXTERNAL_COMMANDS], SANDLOCK_CONFIG_KEYS)
    if (this.config.mountType != null)
      throw new Error('sandlock: mountType needs a remote pipe transport')
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
    _engine: undefined,
    _paths: PathSpec[],
    _texts: string[],
    ctx: Context,
  ): Promise<RunResult> {
    const line = ctx.flags.c
    return this.executeProcess(['/bin/sh', '-c', typeof line === 'string' ? line : ''], ctx)
  }

  runProcess(
    _engine: undefined,
    _paths: PathSpec[],
    texts: string[],
    ctx: Context,
    output: OutputFn | undefined,
    errors?: OutputFn,
  ): Promise<RunResult> {
    return this.executeProcess(texts, ctx, output, errors)
  }

  private async executeProcess(
    argv: string[],
    ctx: Context,
    output?: OutputFn,
    errors?: OutputFn,
  ): Promise<RunResult> {
    const refusal = await cwdRefusal(argv[0] ?? '', ctx.cwd.virtual)
    if (refusal !== null) return refusal
    ctx.signal?.throwIfAborted()
    const wrapper = ['run', ...this.policyArgv(), '--clean-env']
    for (const [key, value] of Object.entries({ ...this.config.env, ...ctx.env }))
      wrapper.push('--env', `${key}=${value}`)
    wrapper.push('--', ...argv)
    // Only host PATH locates the CLI; requested variables go to the confined child.
    const { stdout, stderr, code } = await runCli(
      'sandlock',
      SANDLOCK_CLI_HINT,
      wrapper,
      ctx.stdin,
      {
        cwd: ctx.cwd.virtual,
        env: { PATH: process.env.PATH ?? '' },
        children: this.children,
        ...(output !== undefined ? { output } : {}),
        ...(errors !== undefined ? { errors } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      },
    )
    return { stdout, stderr: stderr.length > 0 ? stderr : null, exitCode: code }
  }

  override close(): Promise<void> {
    return closeChildren(this.children)
  }
}

registerRuntime('sandlock', SandlockRuntime)
