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

import { buildRuntime } from '@struktoai/mirage-core'
import { describe, expect, it } from 'vitest'
import type { RemoteSandboxOptions } from '@struktoai/mirage-core'
import { DockerRuntime } from './runtime.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

interface DockerResult {
  stdout: Uint8Array
  stderr: Uint8Array
  code: number
}

class FakeDockerRuntime extends DockerRuntime {
  calls: [string[], Uint8Array | null][] = []
  files = new Map<string, Uint8Array>()

  protected override docker(
    args: string[],
    stdin: Uint8Array | null = null,
  ): Promise<DockerResult> {
    this.calls.push([args.slice(), stdin])
    const ok = (stdout: string | Uint8Array, stderr = '', code = 0): Promise<DockerResult> =>
      Promise.resolve({
        stdout: typeof stdout === 'string' ? ENC.encode(stdout) : stdout,
        stderr: ENC.encode(stderr),
        code,
      })
    if (args[0] === 'run') return ok('cid-42\n')
    if (args[0] === 'inspect') return ok('true\n')
    if (args[0] === 'rm') return ok('cid-42\n')
    const script = args[args.length - 1] ?? ''
    if (script.includes('"$HOME"')) return ok('/root')
    if (script.startsWith('mkdir -p')) {
      const path = script.split('> ')[1] ?? ''
      this.files.set(path.replaceAll("'", ''), stdin ?? new Uint8Array())
      return ok('')
    }
    if (args[args.length - 2] === 'cat') {
      const data = this.files.get(script)
      if (data === undefined) return ok('', 'cat: no such file', 1)
      return ok(data)
    }
    return ok(`out:${script}`, 'warn')
  }
}

function makeRuntime(options: RemoteSandboxOptions = {}): FakeDockerRuntime {
  return new FakeDockerRuntime(options)
}

describe('DockerRuntime', () => {
  it('maps image, sizing, and args onto docker run', async () => {
    const runtime = makeRuntime({
      config: { image: 'python:3.13', cpu: 2, memory: 4, gpu: 1, args: ['-v', '/host:/mnt/data'] },
    })
    const sandboxId = await runtime.createSandbox()
    expect(sandboxId).toBe('cid-42')
    expect(runtime.calls[0]?.[0]).toEqual([
      'run',
      '-d',
      '--cpus',
      '2',
      '--memory',
      '4g',
      '--gpus',
      '1',
      '-v',
      '/host:/mnt/data',
      'python:3.13',
      'sleep',
      'infinity',
    ])
  })

  it('defaults the image', async () => {
    const runtime = makeRuntime()
    await runtime.createSandbox()
    expect(runtime.calls[0]?.[0]).toContain('python:3.12-slim')
  })

  it('disk sizing fails loud', () => {
    expect(() => makeRuntime({ config: { disk: 10 } })).toThrow('disk')
  })

  it('a template fails loud', () => {
    expect(() => makeRuntime({ config: { template: 'mirage-fuse' } })).toThrow('image')
  })

  it('sdk params fail loud', () => {
    expect(() => makeRuntime({ config: { params: { labels: { team: 'ml' } } } })).toThrow('args')
  })

  it('derives the default workspace root from $HOME', async () => {
    const runtime = makeRuntime({ sandboxId: 'cid-42' })
    expect(await runtime.defaultWorkspaceRoot()).toBe('/root/workspace')
  })

  it('threads cwd, env, stdin, and real stderr through exec', async () => {
    const runtime = makeRuntime({ sandboxId: 'cid-42' })
    const result = await runtime.execLine(
      'wc -l',
      ENC.encode('a\nb\n'),
      { E: '1' },
      '/root/workspace',
    )
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe('out:wc -l')
    expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe('warn')
    const [args, stdin] = runtime.calls.at(-1) ?? [[], null]
    expect(args).toEqual([
      'exec',
      '-i',
      '-w',
      '/root/workspace',
      '-e',
      'E=1',
      'cid-42',
      'sh',
      '-c',
      'wc -l',
    ])
    expect(DEC.decode(stdin ?? new Uint8Array())).toBe('a\nb\n')
  })

  it('upload and download round-trip through exec cat', async () => {
    const runtime = makeRuntime({ sandboxId: 'cid-42' })
    await runtime.upload('/root/workspace/data/train.py', ENC.encode('code'))
    const [args, stdin] = runtime.calls.at(-1) ?? [[], null]
    expect(args.at(-1)).toBe(
      "mkdir -p '/root/workspace/data' && cat > '/root/workspace/data/train.py'",
    )
    expect(DEC.decode(stdin ?? new Uint8Array())).toBe('code')
    const data = await runtime.download('/root/workspace/data/train.py')
    expect(DEC.decode(data)).toBe('code')
  })

  it('download of a missing file fails loud', async () => {
    const runtime = makeRuntime({ sandboxId: 'cid-42' })
    await expect(runtime.download('/root/workspace/missing')).rejects.toThrow('download failed')
  })

  it('a reattached container survives close', async () => {
    const runtime = makeRuntime({ sandboxId: 'cid-live' })
    await runtime.connectSandbox('cid-live')
    await runtime.close()
    expect(runtime.calls.every(([args]) => args[0] !== 'rm')).toBe(true)
  })

  it('close removes only an owned container', async () => {
    const runtime = makeRuntime({ sandboxId: 'cid-42' })
    runtime.ownedSandbox = true
    await runtime.close()
    expect(runtime.calls.at(-1)?.[0]).toEqual(['rm', '-f', 'cid-42'])
  })

  it("registers under the config name 'docker'", () => {
    const runtime = buildRuntime('docker', { config: { image: 'python:3.13' } })
    expect(runtime).toBeInstanceOf(DockerRuntime)
    expect(runtime.captures).toEqual(['*'])
  })
})
