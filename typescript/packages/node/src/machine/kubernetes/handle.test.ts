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

import { materialize, type ByteSource } from '@struktoai/mirage-core/io/types'
import { wrapLine } from '@struktoai/mirage-core/machine/constants'
import { ConnectionLostError } from '@struktoai/mirage-core/machine/errors'
import { buildMachine } from '@struktoai/mirage-core/machine/registry'
import type { OutputFn, RunResult } from '@struktoai/mirage-core/runtime/types'
import { describe, expect, it } from 'vitest'
import type { KubernetesConfig } from './config.ts'
import { ExitLineFilter, exitReportStart, KubernetesMachine } from './handle.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()
const PREFIX = 'command terminated with exit code '
const REPORT = `${PREFIX}3\n`

class FakeKubernetesMachine extends KubernetesMachine {
  phase = 'Running'
  stderr = ''
  code = 0
  readonly calls: [string[], Uint8Array | null][] = []

  protected override async execProgram(
    args: string[],
    source: ByteSource | null = null,
    _output: OutputFn | null = null,
    _signal?: AbortSignal,
    errors: OutputFn | null = null,
  ): Promise<RunResult> {
    const stdin = source === null ? null : await materialize(source)
    this.calls.push([args.slice(), stdin])
    if (args[0] === 'get') {
      return {
        stdout: ENC.encode(JSON.stringify({ status: { phase: this.phase } })),
        stderr: null,
        exitCode: 0,
      }
    }
    if (errors !== null && this.stderr !== '') await errors(ENC.encode(this.stderr))
    return { stdout: ENC.encode('out'), stderr: null, exitCode: this.code }
  }
}

class CutOffMachine extends KubernetesMachine {
  streamed(errors: OutputFn): Promise<RunResult> {
    return this.execArgv(['x'], null, {}, '/', null, errors)
  }

  protected override async execProgram(
    _args: string[],
    _source: ByteSource | null = null,
    _output: OutputFn | null = null,
    _signal?: AbortSignal,
    errors: OutputFn | null = null,
  ): Promise<RunResult> {
    await errors?.(ENC.encode('command'))
    throw new Error('aborted')
  }
}

function makeMachine(
  config: KubernetesConfig | Record<string, unknown> = { pod: 'p' },
  fake: Partial<Pick<FakeKubernetesMachine, 'phase' | 'stderr' | 'code'>> = {},
): FakeKubernetesMachine {
  return Object.assign(new FakeKubernetesMachine('box', config as KubernetesConfig), fake)
}

function collector(): [Uint8Array[], OutputFn] {
  const chunks: Uint8Array[] = []
  return [
    chunks,
    (chunk) => {
      chunks.push(chunk)
      return Promise.resolve()
    },
  ]
}

function text(chunks: readonly Uint8Array[]): string {
  return chunks.map((chunk) => DEC.decode(chunk)).join('')
}

describe('KubernetesMachine', () => {
  it('connect checks the pod is running', async () => {
    const machine = makeMachine({ pod: 'p', namespace: 'agents', context: 'prod' })
    await machine.connect()
    expect(machine.calls[0]?.[0]).toEqual([
      'get',
      'pod',
      '--context',
      'prod',
      '--namespace',
      'agents',
      'p',
      '--output',
      'json',
    ])
  })

  it('connect fails loud on a pod not running', async () => {
    await expect(makeMachine({ pod: 'p' }, { phase: 'Pending' }).connect()).rejects.toThrow(
      'pod p is not running',
    )
  })

  it('pod is required', () => {
    expect(() => makeMachine({})).toThrow('pod')
  })

  it("registers under the config name 'kubernetes'", () => {
    const machine = buildMachine('box', { provider: 'kubernetes', pod: 'p' })
    expect(machine).toBeInstanceOf(KubernetesMachine)
    expect(String(machine.id)).toBe('kubernetes:box')
  })

  it('carries cwd and env on the command', async () => {
    const machine = makeMachine({
      pod: 'p',
      namespace: 'agents',
      container: 'main',
      context: 'prod',
    })
    const result = await machine.execLine('wc -l', ENC.encode('a\n'), { E: '1' }, '/work')
    expect(DEC.decode(result.stdout)).toBe('out')
    expect(result.stderr).toBeNull()
    expect(result.exitCode).toBe(0)
    const [args, stdin] = machine.calls[machine.calls.length - 1] ?? [[], null]
    expect(args).toEqual([
      'exec',
      '--stdin',
      '--quiet',
      '--context',
      'prod',
      '--namespace',
      'agents',
      '--container',
      'main',
      'p',
      '--',
      '/bin/sh',
      '-c',
      wrapLine(['/bin/sh', '-c', 'wc -l'], { E: '1' }, '/work'),
    ])
    expect(DEC.decode(stdin ?? new Uint8Array())).toBe('a\n')
  })

  it('a cut off run keeps what was held', async () => {
    const [chunks, collect] = collector()
    await expect(new CutOffMachine('box', { pod: 'p' }).streamed(collect)).rejects.toThrow(
      'aborted',
    )
    expect(text(chunks)).toBe('command')
  })

  it('a failing program says only what it said', async () => {
    const machine = makeMachine({ pod: 'p' }, { stderr: `boom\n${REPORT}`, code: 3 })
    const result = await machine.execLine('false', null, {}, '/')
    expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe('boom\n')
    expect(result.exitCode).toBe(3)
  })

  it('a failure with no final newline keeps what it wrote', async () => {
    const machine = makeMachine({ pod: 'p' }, { stderr: `boom${REPORT}`, code: 3 })
    const result = await machine.execLine('false', null, {}, '/')
    expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe('boom')
    expect(result.exitCode).toBe(3)
  })

  it('a silent failing program has no stderr', async () => {
    const machine = makeMachine({ pod: 'p' }, { stderr: REPORT, code: 3 })
    const result = await machine.execLine('false', null, {}, '/')
    expect(result.stderr).toBeNull()
    expect(result.exitCode).toBe(3)
  })

  it('a program that prints the report keeps it', async () => {
    const machine = makeMachine({ pod: 'p' }, { stderr: REPORT })
    const result = await machine.execLine('true', null, {}, '/')
    expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe(REPORT)
    expect(result.exitCode).toBe(0)
  })

  it('kubectl failing by itself is a lost connection', async () => {
    const said = 'error: lost connection to pod\n'
    const machine = makeMachine({ pod: 'p' }, { stderr: said, code: 1 })
    const caught = await machine.execLine('sleep 9', null, {}, '/').catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(ConnectionLostError)
    const lost = caught as ConnectionLostError
    expect(DEC.decode(lost.stdout)).toBe('out')
    expect(DEC.decode(lost.stderr ?? new Uint8Array())).toBe(said)
  })

  it("a report for another status is kubectl's own failure", async () => {
    const machine = makeMachine({ pod: 'p' }, { stderr: REPORT, code: 1 })
    await expect(machine.execLine('x', null, {}, '/')).rejects.toBeInstanceOf(ConnectionLostError)
  })
})

describe('exitReportStart', () => {
  it.each<[string, number]>([
    ['', 0],
    ['boom\n', 5],
    ['c', 0],
    ['abc', 2],
    ['boomcommand', 4],
    [`boom${REPORT}`, 4],
    [`${REPORT}${REPORT}`, REPORT.length],
    [PREFIX, 0],
    [`${PREFIX}255`, 0],
    [`${PREFIX}255\n`, 0],
    [`${PREFIX}1234`, PREFIX.length + 4],
    [`${PREFIX}\n`, PREFIX.length + 1],
    [`${PREFIX}1x`, PREFIX.length + 2],
  ])('%j holds from %i', (stderr, start) => {
    expect(exitReportStart(Buffer.from(stderr))).toBe(start)
  })
})

describe('ExitLineFilter', () => {
  it('passes other stderr as it arrives', async () => {
    const [chunks, collect] = collector()
    const said = new ExitLineFilter(collect)
    await said.write(ENC.encode('prompt> '))
    expect(text(chunks)).toBe('prompt> ')
    await said.write(ENC.encode('a\nb\n'))
    expect(text(chunks)).toBe('prompt> a\nb\n')
  })

  it('removes a report split across reads', async () => {
    const [chunks, collect] = collector()
    const said = new ExitLineFilter(collect)
    await said.write(ENC.encode('boom\ncommand term'))
    await said.write(ENC.encode('inated with exit code'))
    await said.write(ENC.encode(' 3\n'))
    expect(await said.finish(3)).toBe(true)
    expect(text(chunks)).toBe('boom\n')
  })

  it('releases a line that only began like the report', async () => {
    const [chunks, collect] = collector()
    const said = new ExitLineFilter(collect)
    await said.write(ENC.encode('command'))
    expect(chunks).toEqual([])
    await said.write(ENC.encode('s failed\n'))
    expect(text(chunks)).toBe('commands failed\n')
    expect(await said.finish(0)).toBe(true)
  })

  it('does not hold a report of endless digits', async () => {
    const [chunks, collect] = collector()
    const said = new ExitLineFilter(collect)
    await said.write(ENC.encode(PREFIX))
    await said.write(ENC.encode('1'.repeat(100_000)))
    expect(text(chunks)).toBe(`${PREFIX}${'1'.repeat(100_000)}`)
    expect(await said.finish(0)).toBe(true)
  })

  it('releases a held line when kubectl exits zero', async () => {
    const [chunks, collect] = collector()
    const said = new ExitLineFilter(collect)
    await said.write(ENC.encode('command'))
    expect(await said.finish(0)).toBe(true)
    expect(text(chunks)).toBe('command')
  })
})
