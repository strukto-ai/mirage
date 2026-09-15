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

import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PathSpec } from '@struktoai/mirage-core/types'
import { buildRuntime } from '@struktoai/mirage-core/runtime/table'
import type { ProcessExecution } from '@struktoai/mirage-core/runtime/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SandlockRuntime } from './runtime.ts'

const DEC = new TextDecoder()
interface Capture {
  argv: string[]
  env: Record<string, string>
  cwd: string
  stdin: string
}

function request(argv: ProcessExecution['argv'], cwd = '/'): ProcessExecution {
  return { kind: 'process', argv, cwd: PathSpec.fromStrPath(cwd), env: {}, stdin: null }
}

describe.skipIf(process.platform === 'win32')('SandlockRuntime', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirage-sandlock-'))
    await writeFile(
      join(dir, 'sandlock'),
      `#!${process.execPath}
const args = process.argv.slice(2)
if (args.at(-1) === 'wait') setInterval(() => {}, 1000)
else {
  let stdin = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', data => stdin += data)
  process.stdin.on('end', () => console.log(JSON.stringify({argv: args, env: process.env, cwd: process.cwd(), stdin})))
}
`,
      { mode: 0o755 },
    )
    vi.stubEnv('PATH', dir)
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
  })

  it('preserves argv, cwd, stdin and confines requested environment to child flags', async () => {
    vi.stubEnv('MIRAGE_HOST_ONLY', 'must-not-inherit')
    const runtime = new SandlockRuntime({
      config: {
        env: { E: 'config', BASE: 'yes' },
        fsReadable: ['/data'],
        fsWritable: ['/work'],
        maxMemory: '512M',
      },
    })
    const argv = ['node', 'a b', '$(echo literal)', '', '--flag'] as const
    const result = await runtime.execute({
      ...request(argv, dir),
      env: { E: 'request', LD_PRELOAD: '/guest-only.so' },
      stdin: new TextEncoder().encode('input\n'),
    })
    expect(result.exitCode).toBe(0)
    const data = JSON.parse(DEC.decode(result.stdout)) as Capture
    expect(data.argv.slice(data.argv.indexOf('--') + 1)).toEqual(argv)
    expect(data.argv.slice(1, 1 + runtime.policyArgv().length)).toEqual(runtime.policyArgv())
    expect(data.argv).toContain('--clean-env')
    expect(data.argv).toContain('E=request')
    expect(data.argv).not.toContain('E=config')
    expect(data.argv).toContain('BASE=yes')
    expect(data.argv).toContain('LD_PRELOAD=/guest-only.so')
    expect(data.env).not.toHaveProperty('MIRAGE_HOST_ONLY')
    expect(data.env).not.toHaveProperty('LD_PRELOAD')
    expect(data.env).not.toHaveProperty('E')
    expect(data.cwd).toBe(await realpath(dir))
    expect(data.stdin).toBe('input\n')
  })

  it('keeps shell interpretation explicit', async () => {
    const runtime = new SandlockRuntime()
    const result = await runtime.execute({
      kind: 'shell',
      line: 'node --version | cat',
      cwd: PathSpec.fromStrPath(dir),
      env: {},
      stdin: null,
    })
    const data = JSON.parse(DEC.decode(result.stdout)) as Capture
    expect(data.argv.slice(-4)).toEqual(['--', '/bin/sh', '-c', 'node --version | cat'])
  })

  it('registers process and shell support without claiming language or workspace filesystem APIs', () => {
    const runtime = buildRuntime('sandlock')
    expect(runtime).toBeInstanceOf(SandlockRuntime)
    expect(runtime.captures).toEqual(['@external'])
    expect(runtime.capabilities).toMatchObject({
      process: true,
      shell: true,
      languages: [],
      filesystem: [],
      reach: 'process',
    })
    expect(() => buildRuntime('sandlock', { config: { home: 'python3' } })).toThrow('home')
  })

  it('reports an absent CLI', async () => {
    await rm(join(dir, 'sandlock'))
    await expect(new SandlockRuntime().execute(request(['node']))).rejects.toThrow(
      'sandlock CLI on PATH',
    )
  })

  it('rejects empty argv', async () => {
    await expect(
      new SandlockRuntime().execute(request([] as unknown as ProcessExecution['argv'])),
    ).rejects.toThrow('argv must not be empty')
  })

  it('cancels the CLI', async () => {
    const controller = new AbortController()
    const runtime = new SandlockRuntime()
    const running = runtime.execute({ ...request(['wait']), signal: controller.signal })
    const checked = expect(running).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await checked
    await runtime.close()
  })
})
