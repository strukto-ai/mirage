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
import {
  registerRuntime,
  RemoteSandbox,
  type RuntimeOptions,
  type RunResult,
} from '@struktoai/mirage-core'
import { DOCKER_CONFIG_KEYS, type DockerConfig } from './config.ts'
import { DOCKER_CLI_HINT } from './constants.ts'

interface DockerResult {
  stdout: Uint8Array
  stderr: Uint8Array
  code: number
}

/**
 * A container the user runs as a whole-line runtime.
 *
 * You start the container yourself; mirage only connects to it and
 * execs lines. The docker CLI is the transport (Docker Desktop,
 * colima, or a podman alias all work), so there is no SDK dependency
 * and no daemon socket wiring; each line is one `docker exec -i` with
 * the merged environment, the rebased cwd, real stdin, and separated
 * stderr.
 */
export class DockerRuntime extends RemoteSandbox<DockerConfig> {
  readonly name = 'docker'

  constructor(options: RuntimeOptions<DockerConfig> | Record<string, unknown> = {}) {
    super(options, DOCKER_CONFIG_KEYS)
    if (!this.config.container) {
      throw new Error('docker config needs container: the id or name of a running container')
    }
  }

  // One docker CLI invocation; the seam tests override.
  protected docker(args: string[], stdin: Uint8Array | null = null): Promise<DockerResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
      child.on('error', (error: NodeJS.ErrnoException) => {
        reject(error.code === 'ENOENT' ? new Error(DOCKER_CLI_HINT) : error)
      })
      child.on('close', (code) => {
        resolve({
          stdout: new Uint8Array(Buffer.concat(out)),
          stderr: new Uint8Array(Buffer.concat(err)),
          code: code ?? 1,
        })
      })
      // EPIPE means the container command exited without draining its
      // stdin (`head`-like); python's communicate() suppresses the
      // matching BrokenPipeError, so it is not an error here either.
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') reject(error)
      })
      if (stdin !== null) child.stdin.write(stdin)
      child.stdin.end()
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
      throw new Error(`docker inspect failed: ${decode(result.stderr).trim()}`)
    }
    if (decode(result.stdout).trim() !== 'true') {
      throw new Error(`container ${this.config.container} is not running`)
    }
  }

  async execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult> {
    const args = ['exec', '-i', '-w', cwd]
    for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`)
    args.push(this.config.container, 'sh', '-c', line)
    const result = await this.docker(args, stdin)
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code }
  }
}

const DECODER = new TextDecoder()

function decode(bytes: Uint8Array): string {
  return DECODER.decode(bytes)
}

registerRuntime('docker', DockerRuntime)
