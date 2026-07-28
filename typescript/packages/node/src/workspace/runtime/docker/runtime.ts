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
  type RemoteSandboxOptions,
  rstripSlash,
  type RunResult,
} from '@struktoai/mirage-core'
import { DOCKER_CONFIG_KEYS, type DockerConfig } from './config.ts'

const DEFAULT_IMAGE = 'python:3.12-slim'

const INSTALL_HINT =
  'the docker runtime needs the docker CLI on PATH (Docker Desktop, colima, or a podman alias)'

export const DOCKER_OPTION_KEYS: readonly string[] = [
  'captures',
  'config',
  'sandboxId',
  'workspaceRoot',
  'script',
  'mount',
]

interface DockerResult {
  stdout: Uint8Array
  stderr: Uint8Array
  code: number
}

/**
 * A local Docker container as a whole-line runtime.
 *
 * Drives the docker CLI directly (Docker Desktop, colima, or a podman
 * alias all work), so there is no SDK dependency and no daemon socket
 * wiring. DockerConfig maps onto the CLI: `image` is pulled on first
 * use (python:3.12-slim when omitted), sizing becomes
 * --cpus/--memory/--gpus, and `args` passes any extra `docker run`
 * flag verbatim before the image (binds, --cap-add, --network,
 * --user, ...). Containers get real stdin and separated stderr.
 */
export class DockerRuntime extends RemoteSandbox<DockerConfig> {
  readonly name = 'docker'

  constructor(options: RemoteSandboxOptions<DockerConfig> | Record<string, unknown> = {}) {
    super(options, DOCKER_CONFIG_KEYS)
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
        reject(error.code === 'ENOENT' ? new Error(INSTALL_HINT) : error)
      })
      child.on('close', (code) => {
        resolve({
          stdout: new Uint8Array(Buffer.concat(out)),
          stderr: new Uint8Array(Buffer.concat(err)),
          code: code ?? 1,
        })
      })
      if (stdin !== null) child.stdin.write(stdin)
      child.stdin.end()
    })
  }

  private resourceArgs(): string[] {
    const args: string[] = []
    const { cpu, memory, gpu } = this.config
    if (cpu !== undefined) args.push('--cpus', String(cpu))
    if (memory !== undefined) args.push('--memory', `${String(memory)}g`)
    if (gpu !== undefined) args.push('--gpus', String(gpu))
    return args
  }

  async createSandbox(): Promise<string> {
    const image = this.config.image ?? DEFAULT_IMAGE
    const result = await this.docker([
      'run',
      '-d',
      ...this.resourceArgs(),
      ...(this.config.args ?? []),
      image,
      'sleep',
      'infinity',
    ])
    if (result.code !== 0) {
      throw new Error(`docker run failed: ${decode(result.stderr).trim()}`)
    }
    return decode(result.stdout).trim()
  }

  async connectSandbox(sandboxId: string): Promise<void> {
    const result = await this.docker(['inspect', '--format', '{{.State.Running}}', sandboxId])
    if (result.code !== 0) {
      throw new Error(`docker inspect failed: ${decode(result.stderr).trim()}`)
    }
    if (decode(result.stdout).trim() !== 'true') {
      throw new Error(`container ${sandboxId} is not running`)
    }
  }

  /**
   * $HOME/workspace: containers usually run as root, so this is
   * /root/workspace on stock images; custom-user images get their own
   * home the same way.
   */
  override async defaultWorkspaceRoot(): Promise<string> {
    const result = await this.docker(['exec', this.requireId(), 'sh', '-c', 'printf "%s" "$HOME"'])
    const home = rstripSlash(decode(result.stdout).trim())
    return `${home}/workspace`
  }

  async execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult> {
    const args = ['exec', '-i', '-w', cwd]
    for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`)
    args.push(this.requireId(), 'sh', '-c', line)
    const result = await this.docker(args, stdin)
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code }
  }

  async upload(path: string, data: Uint8Array): Promise<void> {
    const slash = path.lastIndexOf('/')
    const parent = slash > 0 ? path.slice(0, slash) : '/'
    const script = `mkdir -p ${quote(parent)} && cat > ${quote(path)}`
    const result = await this.docker(['exec', '-i', this.requireId(), 'sh', '-c', script], data)
    if (result.code !== 0) {
      throw new Error(`docker upload failed: ${decode(result.stderr).trim()}`)
    }
  }

  async download(path: string): Promise<Uint8Array> {
    const result = await this.docker(['exec', this.requireId(), 'cat', path])
    if (result.code !== 0) {
      throw new Error(`docker download failed: ${decode(result.stderr).trim()}`)
    }
    return result.stdout
  }

  async close(): Promise<void> {
    if (this.sandboxId !== null && this.ownedSandbox) {
      await this.docker(['rm', '-f', this.sandboxId])
    }
  }

  private requireId(): string {
    if (this.sandboxId === null) throw new Error('docker container not started')
    return this.sandboxId
  }
}

const DECODER = new TextDecoder()

function decode(bytes: Uint8Array): string {
  return DECODER.decode(bytes)
}

function quote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`
}

registerRuntime('docker', DockerRuntime, DOCKER_OPTION_KEYS)
