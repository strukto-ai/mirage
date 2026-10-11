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

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime } from '@struktoai/mirage-core/runtime/table'
import type { RuntimeOptions } from '@struktoai/mirage-core/runtime/config'
import { describe, expect, it } from 'vitest'
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

  it('takes a mountType of ssh, fuse or both', () => {
    expect(() => new DockerRuntime({ config: { container: 'c', mountType: 'nfs' } })).toThrow(
      'docker mountType must be one of ssh, fuse, both, not "nfs"',
    )
    expect(() => new DockerRuntime({ config: { container: 'c', mountType: 'ssh' } })).not.toThrow()
  })

  it("registers under the config name 'docker'", () => {
    const runtime = buildRuntime('docker', { config: { container: 'cid-42' } })
    expect(runtime).toBeInstanceOf(DockerRuntime)
    expect(runtime.captures).toEqual(['@external'])
  })
})

// A fake `docker` on PATH running `script`, for the real spawn path.
async function withFakeDocker(script: string, run: (fake: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-docker-'))
  const fake = join(dir, 'docker')
  await writeFile(fake, script, { mode: 0o755 })
  const savedPath = process.env.PATH
  process.env.PATH = `${dir}:${savedPath ?? ''}`
  try {
    await run(fake)
  } finally {
    process.env.PATH = savedPath
    await rm(dir, { recursive: true, force: true })
  }
}

// The real spawn path: a container command that exits without draining
// its stdin EPIPEs the pipe. Without the stdin error guard the stream's
// unhandled 'error' event crashes the whole process (python suppresses
// the matching BrokenPipeError inside communicate()). A fake `docker`
// on PATH that ignores stdin reproduces it against the real spawn.
describe.skipIf(process.platform === 'win32')('DockerRuntime stdin EPIPE', () => {
  it('a command that ignores a large stdin resolves instead of crashing', async () => {
    await withFakeDocker('#!/bin/sh\nexit 0\n', async () => {
      const runtime = new DockerRuntime({ config: { container: 'cid-42' } })
      const big = new Uint8Array(4 * 1024 * 1024)
      const result = await runtime.execLine('head -1', big, {}, '/')
      expect(result.exitCode).toBe(0)
    })
  })
})

describe.skipIf(process.platform === 'win32')('DockerRuntime pipe', () => {
  it('holds docker exec open byte for byte', async () => {
    await withFakeDocker(`#!/bin/sh\nprintf '%s\\n' "$@" > "$0.args"\nexec cat\n`, async (fake) => {
      const runtime = new DockerRuntime({ config: { container: 'cid-42' } })
      const pipe = await runtime.openPipe('exec sshfs x y')
      const payload = Uint8Array.from({ length: 256 }, (_, i) => i)
      pipe.writer.write(payload)
      pipe.writer.end()
      const got: number[] = []
      for await (const chunk of pipe.reader) got.push(...chunk)
      expect(got).toEqual([...payload])
      await pipe.stop()
      expect((await readFile(`${fake}.args`, 'utf8')).split('\n')).toEqual([
        'exec',
        '-i',
        'cid-42',
        'sh',
        '-c',
        'exec sshfs x y',
        '',
      ])
    })
  })

  it('outlives a command that ends before its answer is written', async () => {
    await withFakeDocker('#!/bin/sh\nexit 0\n', async () => {
      const runtime = new DockerRuntime({ config: { container: 'cid-42' } })
      const pipe = await runtime.openPipe('exec sshfs x y')
      const chunks = pipe.reader.getReader()
      while (!(await chunks.read()).done) continue
      pipe.writer.write(new Uint8Array(4 * 1024 * 1024))
      await pipe.stop()
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
  })
})
