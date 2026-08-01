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

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime } from '@struktoai/mirage-core'
import { describe, expect, it } from 'vitest'
import type { RuntimeOptions } from '@struktoai/mirage-core'
import type { DockerConfig } from './config.ts'
import { DockerRuntime } from './runtime.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

interface DockerResult {
  stdout: Uint8Array
  stderr: Uint8Array
  code: number
}

class FakeDockerRuntime extends DockerRuntime {
  running = true
  readonly calls: [string[], Uint8Array | null][] = []

  protected override docker(
    args: string[],
    stdin: Uint8Array | null = null,
  ): Promise<DockerResult> {
    this.calls.push([args.slice(), stdin])
    if (args[0] === 'inspect') {
      return Promise.resolve({
        stdout: ENC.encode(this.running ? 'true\n' : 'false\n'),
        stderr: new Uint8Array(),
        code: 0,
      })
    }
    const script = args[args.length - 1] ?? ''
    return Promise.resolve({
      stdout: ENC.encode(`out:${script}`),
      stderr: ENC.encode('warn'),
      code: 0,
    })
  }
}

function makeRuntime(
  options: RuntimeOptions<DockerConfig> | Record<string, unknown> = {
    config: { container: 'cid-42' },
  },
): FakeDockerRuntime {
  return new FakeDockerRuntime(options)
}

describe('DockerRuntime', () => {
  it('connect checks the user container is running', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    expect(runtime.calls[0]?.[0]).toEqual(['inspect', '--format', '{{.State.Running}}', 'cid-42'])
  })

  it('connect fails loud on a stopped container', async () => {
    const runtime = makeRuntime()
    runtime.running = false
    await expect(runtime.connect()).rejects.toThrow('not running')
  })

  it('container is required', () => {
    expect(() => makeRuntime({ config: {} })).toThrow('container')
  })

  it('threads cwd, env, stdin, and real stderr through exec', async () => {
    const runtime = makeRuntime()
    const result = await runtime.execLine('wc -l', ENC.encode('a\nb\n'), { E: '1' }, '/root/ws')
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe('out:wc -l')
    expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe('warn')
    const [args, stdin] = runtime.calls[runtime.calls.length - 1] ?? [[], null]
    expect(args).toEqual([
      'exec',
      '-i',
      '-w',
      '/root/ws',
      '-e',
      'E=1',
      'cid-42',
      'sh',
      '-c',
      'wc -l',
    ])
    expect(DEC.decode(stdin ?? new Uint8Array())).toBe('a\nb\n')
  })

  it("registers under the config name 'docker'", () => {
    const runtime = buildRuntime('docker', { config: { container: 'cid-42' } })
    expect(runtime).toBeInstanceOf(DockerRuntime)
    expect(runtime.captures).toEqual(['*'])
  })
})

// The real spawn path: a container command that exits without draining
// its stdin EPIPEs the pipe. Without the stdin error guard the stream's
// unhandled 'error' event crashes the whole process (python suppresses
// the matching BrokenPipeError inside communicate()). A fake `docker`
// on PATH that ignores stdin reproduces it against the real spawn.
describe.skipIf(process.platform === 'win32')('DockerRuntime stdin EPIPE', () => {
  it('a command that ignores a large stdin resolves instead of crashing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fake-docker-'))
    const fake = join(dir, 'docker')
    await writeFile(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const savedPath = process.env.PATH
    process.env.PATH = `${dir}:${savedPath ?? ''}`
    try {
      const runtime = new DockerRuntime({ config: { container: 'cid-42' } })
      const big = new Uint8Array(4 * 1024 * 1024)
      const result = await runtime.execLine('head -1', big, {}, '/')
      expect(result.exitCode).toBe(0)
    } finally {
      process.env.PATH = savedPath
      await rm(dir, { recursive: true, force: true })
    }
  })
})
