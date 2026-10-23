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

import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { RemoteSandbox } from '@struktoai/mirage-core/runtime/sandbox/base'
import { PIPE_TRANSPORT, type PipeTransport } from '@struktoai/mirage-core/runtime/sandbox/mixin'
import { requireId } from '@struktoai/mirage-core/runtime/sandbox/config'
import { registerRuntime } from '@struktoai/mirage-core/runtime/table'
import type { OutputFn, RunResult, SandboxPipe } from '@struktoai/mirage-core/runtime/types'
import type { RuntimeOptions } from '@struktoai/mirage-core/runtime/config'
import { DOCKER_CONFIG_KEYS, type DockerConfig } from './config.ts'
import { DOCKER_CLI_HINT } from './constants.ts'
import { type CliResult, execArgs, openCliPipe, runCli } from '../cli.ts'

/**
 * A container the user runs as a whole-line runtime.
 *
 * You start the container yourself; mirage only connects to it and
 * execs lines. The docker CLI is the transport (Docker Desktop,
 * colima, or a podman alias all work), so there is no SDK dependency
 * and no daemon socket wiring; each line is one `docker exec -i` with
 * the merged environment, the session cwd, real stdin, and separated
 * stderr.
 */
export class DockerRuntime extends RemoteSandbox<DockerConfig> implements PipeTransport {
  readonly [PIPE_TRANSPORT] = true as const
  readonly name = 'docker'

  constructor(options: RuntimeOptions<DockerConfig> = {}) {
    super(options, DOCKER_CONFIG_KEYS)
    requireId('docker', 'container', this.config.container)
  }

  // One docker CLI invocation; the seam tests override.
  protected docker(
    args: string[],
    stdin: ByteSource | null = null,
    output: OutputFn | null = null,
    signal?: AbortSignal,
    errors: OutputFn | null = null,
  ): Promise<CliResult> {
    return runCli('docker', DOCKER_CLI_HINT, args, stdin, {
      ...(signal !== undefined ? { signal } : {}),
      ...(output !== null ? { output } : {}),
      ...(errors !== null ? { errors } : {}),
    })
  }

  async connect(): Promise<void> {
    const result = await this.docker([
      'inspect',
      '--format',
      '{{.State.Running}}',
      this.config.container,
    ])
    if (result.code !== 0) {
      throw new Error(`docker inspect failed: ${DECODER.decode(result.stderr).trim()}`)
    }
    if (DECODER.decode(result.stdout).trim() !== 'true') {
      throw new Error(`container ${this.config.container} is not running`)
    }
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn | null,
    errors: OutputFn | null,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const args = execArgs(['exec', '-i'], [this.config.container], env, cwd, argv)
    const result = await this.docker(args, stdin, output, signal, errors)
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code }
  }

  openPipe(command: string): Promise<SandboxPipe> {
    return openCliPipe(
      'docker',
      execArgs(['exec', '-i'], [this.config.container], {}, null, ['/bin/sh', '-c', command]),
    )
  }
}

const DECODER = new TextDecoder()

registerRuntime('docker', DockerRuntime)
