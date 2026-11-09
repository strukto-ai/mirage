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

import { describe, expect, it, vi } from 'vitest'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { FileStat, FileType, Limit, MountMode, PathSpec } from '../types.ts'
import { LookupStatus } from '../cache/index/config.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import { materialize, type ByteSource } from '../io/types.ts'
import { shellJoin } from '../shell/join.ts'
import { ConnectionLostError } from './errors.ts'
import { MachineHandle } from './handle.ts'
import {
  PROCESS,
  FAKETIME_PROBE_SECONDS,
  faketimeProbe,
  isRun,
  NOT_RUNNING_STATUS,
  MACHINE_STOP_WAIT_SECONDS,
  runTag,
  stopLine,
} from './constants.ts'
import { LanguageRuntime } from '../runtime/language.ts'
import { isLineExecutor } from '../runtime/mixin.ts'
import type { RunResult } from '../runtime/types.ts'
import type { MachineConfig } from './config.ts'
import { ProcessTable } from '../execution/process/table.ts'
import { runAsProcess } from '../context/session_context.ts'
import { machineRuntime, on } from '../../tests/fixtures/machine.ts'
import { FIRST_PID } from '../execution/process/constants.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// The argv a sandbox runs, as the line the fakes answer.
function lineOf(argv: readonly string[]): string {
  const run = isRun(argv) ? argv.slice(7) : argv
  return run[0] === '/bin/sh' && run[1] === '-c' ? (run[2] ?? '') : shellJoin(run)
}

class RecordingMachine extends MachineHandle {
  static override readonly provider = 'recbox'
  readonly captures: readonly string[] | undefined
  readonly execs: [string, Uint8Array | null, Record<string, string>, string][] = []
  connectedCount = 0

  constructor(options: { captures?: readonly string[]; config?: MachineConfig } = {}) {
    super('box', options.config)
    this.captures = options.captures
  }

  connect(): Promise<void> {
    this.connectedCount += 1
    return Promise.resolve()
  }

  override execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult> {
    this.execs.push([line, stdin, env, cwd])
    return Promise.resolve({ stdout: ENC.encode(`ran:${line}`), stderr: null, exitCode: 0 })
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult> {
    const given = isRun(argv) ? { ...env, [PROCESS]: runTag(argv) } : env
    return this.execLine(lineOf(argv), stdin === null ? null : await materialize(stdin), given, cwd)
  }
}

// A box whose connection drops while it runs `train`.
class DroppedBox extends RecordingMachine {
  error: Error = new ConnectionLostError(
    'closed by remote host',
    ENC.encode('step 0\n'),
    ENC.encode('warn\n'),
  )

  override async execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult> {
    const result = await super.execLine(line, stdin, env, cwd)
    if (line.startsWith('train')) throw this.error
    return result
  }
}

function sandboxWorkspace(box: RecordingMachine): Workspace {
  return new Workspace(
    { '/data': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      ...on(box, 'workspace'),
    },
  )
}

describe('MachineHandle', () => {
  it.each(['python3 --version', 'python -V', 'node --version', 'node -v', 'tsc --version'])(
    'passes %s and its output through the remote environment',
    async (line) => {
      const box = new RecordingMachine({ captures: line.split(' ', 1) })
      const ws = sandboxWorkspace(box)
      try {
        const io = await ws.shell(line)
        expect(io.exitCode).toBe(0)
        expect(DEC.decode(io.stdout)).toBe(`ran:${line}`)
        expect(box.execs[0]?.[0]).toBe(line)
      } finally {
        await ws.close()
      }
    },
  )

  it('hands a program the system time through the libfaketime the machine holds', async () => {
    // Answers the probe as a sandbox holding `holds`, or none when empty.
    class FaketimeBox extends RecordingMachine {
      constructor(private readonly holds: string) {
        super({ captures: ['python3'] })
      }

      override execLine(
        line: string,
        stdin: Uint8Array | null,
        env: Record<string, string>,
        cwd: string,
      ): Promise<RunResult> {
        if (line !== faketimeProbe()) return super.execLine(line, stdin, env, cwd)
        this.execs.push([line, stdin, env, cwd])
        const found = this.holds === '' ? '' : `${this.holds}\n`
        return Promise.resolve({ stdout: ENC.encode(found), stderr: null, exitCode: 0 })
      }
    }
    for (const [holds, systemTime] of [
      ['/usr/lib/faketime/libfaketime.so.1', '2026-03-02T09:00:00Z'],
      ['', '2026-03-02T09:00:00Z'],
      ['/usr/lib/faketime/libfaketime.so.1', null],
    ] as const) {
      const box = new FaketimeBox(holds)
      const ws = new Workspace(
        { '/data': new RAMVFS() },
        {
          mode: MountMode.EXEC,
          ...on(box, 'workspace'),
          ...(systemTime === null ? {} : { systemTime }),
        },
      )
      try {
        await ws.shell('python3 a')
        await ws.shell('python3 b')
        const probes = box.execs.filter(([line]) => line === faketimeProbe())
        expect(probes).toHaveLength(systemTime === null ? 0 : 1)
        const env = box.execs.at(-1)?.[2] ?? {}
        if (holds !== '' && systemTime !== null) {
          expect(env).toMatchObject({ LD_PRELOAD: holds, FAKETIME_FMT: '%s' })
          expect(Number((env.FAKETIME ?? '').slice(1))).toBeCloseTo(1772442000, -1)
        } else {
          expect(env).not.toHaveProperty('FAKETIME')
        }
      } finally {
        await ws.close()
      }
    }
  })

  it('asks a machine once, shares a probe in flight and asks again after a failure', async () => {
    // `answers` is what its probes exit with, in turn.
    class CountedBox extends RecordingMachine {
      readonly answers: number[] = [1, 0]
      probes = 0

      constructor() {
        super({ captures: ['python3'] })
      }

      override async execLine(
        line: string,
        stdin: Uint8Array | null,
        env: Record<string, string>,
        cwd: string,
      ): Promise<RunResult> {
        if (line !== faketimeProbe()) return super.execLine(line, stdin, env, cwd)
        this.probes += 1
        await new Promise((resolve) => setTimeout(resolve, 10))
        const exitCode = this.answers.shift() ?? 0
        return {
          stdout: ENC.encode('/usr/lib/faketime/libfaketime.so.1\n'),
          stderr: null,
          exitCode,
        }
      }
    }
    const box = new CountedBox()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.EXEC, ...on(box, 'workspace'), systemTime: '2026-03-02T09:00:00Z' },
    )
    try {
      await ws.shell('python3 a')
      expect(box.execs.at(-1)?.[2]).not.toHaveProperty('FAKETIME')
      await Promise.all([ws.shell('python3 b'), ws.shell('python3 c')])
      expect(box.execs.at(-1)?.[2]).toHaveProperty('FAKETIME')
      await ws.shell('python3 d')
      expect(box.probes).toBe(2)
    } finally {
      await ws.close()
    }
  })

  it('gives up on a probe its provider does not stop, and asks again', async () => {
    // The first probe never answers and ignores its signal, as Daytona's lines do.
    class StalledBox extends RecordingMachine {
      probes = 0

      constructor() {
        super({ captures: ['python3'] })
      }

      override execLine(
        line: string,
        stdin: Uint8Array | null,
        env: Record<string, string>,
        cwd: string,
      ): Promise<RunResult> {
        if (line !== faketimeProbe()) return super.execLine(line, stdin, env, cwd)
        this.probes += 1
        if (this.probes === 1) return new Promise(() => undefined)
        return Promise.resolve({
          stdout: ENC.encode('/usr/lib/faketime/libfaketime.so.1\n'),
          stderr: null,
          exitCode: 0,
        })
      }
    }
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    const spy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => timeout(ms === FAKETIME_PROBE_SECONDS * 1000 ? 20 : ms))
    const box = new StalledBox()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.EXEC, ...on(box, 'workspace'), systemTime: '2026-03-02T09:00:00Z' },
    )
    try {
      await ws.shell('python3 a')
      expect(box.execs.at(-1)?.[2]).not.toHaveProperty('FAKETIME')
      await ws.shell('python3 b')
      expect(box.execs.at(-1)?.[2]).toHaveProperty('FAKETIME')
      expect(box.probes).toBe(2)
    } finally {
      spy.mockRestore()
      await ws.close()
    }
  })

  it('connects on the first line only', async () => {
    const box = new RecordingMachine({ captures: ['python3'] })
    const ws = sandboxWorkspace(box)
    try {
      const io = await ws.shell('python3 x')
      expect(DEC.decode(io.stdout)).toBe('ran:python3 x')
      expect(box.connectedCount).toBe(1)
      await ws.shell('python3 x')
      // The runtime connects on the first line, not per line.
      expect(box.connectedCount).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('a failed connect retries on the next line', async () => {
    class FlakyBox extends RecordingMachine {
      override connect(): Promise<void> {
        this.connectedCount += 1
        if (this.connectedCount === 1) return Promise.reject(new Error('sandbox not running'))
        return Promise.resolve()
      }
    }
    const box = new FlakyBox({ captures: ['python3'] })
    const ws = sandboxWorkspace(box)
    try {
      const first = await ws.shell('python3 x')
      expect(first.exitCode).not.toBe(0)
      expect(DEC.decode(first.stderr)).toContain('not running')
      const second = await ws.shell('python3 x')
      expect(second.exitCode).toBe(0)
      expect(box.connectedCount).toBe(2)
    } finally {
      await ws.close()
    }
  })

  it('connects again when another workspace takes the handle', async () => {
    const box = new RecordingMachine({ captures: ['python3'] })
    for (let round = 0; round < 2; round++) {
      const ws = sandboxWorkspace(box)
      try {
        expect((await ws.shell('python3 x')).exitCode).toBe(0)
      } finally {
        await ws.close()
      }
    }
    expect(box.connectedCount).toBe(2)
  })

  it('passes cwd through verbatim and merges env', async () => {
    const box = new RecordingMachine({ captures: ['@line'], config: { env: { BASE: '1' } } })
    const result = await machineRuntime(box).runLine(undefined, [], [], {
      flags: { c: 'nvidia-smi' },
      stdin: null,
      env: { LINE: '2' },
      cwd: PathSpec.fromStrPath('/data/deep'),
    })
    expect(result.exitCode).toBe(0)
    const [, , env, cwd] = box.execs[box.execs.length - 1] ?? [
      '',
      null,
      {} as Record<string, string>,
      '',
    ]
    // The sandbox serves the workspace at the same prefixes as the
    // host, so nothing is rewritten.
    expect(cwd).toBe('/data/deep')
    expect(env.BASE).toBe('1')
    expect(env.LINE).toBe('2')
  })

  it('passes stdin bytes through to execLine', async () => {
    const box = new RecordingMachine({ captures: ['@line'] })
    const ws = sandboxWorkspace(box)
    try {
      await ws.shell('wc -l', { stdin: ENC.encode('a\nb\n') })
      const [, stdin] = box.execs[box.execs.length - 1] ?? ['', null, {}, '']
      expect(DEC.decode(stdin ?? new Uint8Array())).toBe('a\nb\n')
    } finally {
      await ws.close()
    }
  })

  it('machines take lines, not stages', () => {
    // A machine's runtime is a line executor, never the engine inside one
    // command: it carries the line entry point and no interpreter entry point.
    const runtime = machineRuntime(new RecordingMachine())
    expect(isLineExecutor(runtime)).toBe(true)
    expect(runtime).not.toBeInstanceOf(LanguageRuntime)
  })

  it('ends a line whose connection dropped as hung up', async () => {
    const box = new DroppedBox({ captures: ['train'] })
    const ws = sandboxWorkspace(box)
    try {
      const io = await ws.shell('train')
      expect(io.exitCode).toBe(129)
      expect(DEC.decode(io.stderr)).toBe(`warn\nmirage: ${String(box.id)}: connection lost\n`)
    } finally {
      await ws.close()
    }
  })

  // Only a transport's own ConnectionError means the connection went; an
  // error of another name from elsewhere in the run stays the error it is.
  // A run whose output was kept rather than streamed keeps what it read
  // before the drop.
  it('keeps the output a dropped run read', async () => {
    const box = new DroppedBox({ captures: ['train'] })
    const ran = await machineRuntime(box).runLine(undefined, [], [], {
      flags: { c: 'train' },
      stdin: null,
      cwd: PathSpec.fromStrPath('/'),
    })
    expect([ran.exitCode, DEC.decode(ran.stdout), DEC.decode(ran.stderr ?? undefined)]).toEqual([
      129,
      'step 0\n',
      `warn\nmirage: ${String(box.id)}: connection lost\n`,
    ])
  })

  it('lists a job whose connection dropped as hung up', async () => {
    const box = new DroppedBox({ captures: ['train'] })
    const ws = sandboxWorkspace(box)
    try {
      await ws.shell('train &')
      let rows = 'Running'
      while (rows.includes('Running')) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        rows = DEC.decode((await ws.shell('jobs')).stdout)
      }
      expect(rows.endsWith('[1]+  Hangup                  train\n')).toBe(true)
    } finally {
      await ws.close()
    }
  })

  // Only a transport's ConnectionLostError means the connection went; any
  // other error from elsewhere in the run stays the error it is.
  it('leaves another error alone', async () => {
    const box = new DroppedBox({ captures: ['train'] })
    box.error = Object.assign(new Error('read ECONNRESET'), { name: 'ConnectionError' })
    const ws = sandboxWorkspace(box)
    try {
      const io = await ws.shell('train')
      expect(io.exitCode).not.toBe(129)
      expect(DEC.decode(io.stderr)).not.toContain('connection lost')
    } finally {
      await ws.close()
    }
  })

  it('reports a job whose connection dropped as hung up', async () => {
    const box = new DroppedBox({ captures: ['train'] })
    const ws = sandboxWorkspace(box)
    try {
      await ws.shell('train &')
      const io = await ws.shell('wait %1')
      expect(io.exitCode).toBe(129)
      expect(DEC.decode(io.stderr)).toContain('Hangup')
    } finally {
      await ws.close()
    }
  })

  it('a line timeout answers 124', async () => {
    class SlowBox extends RecordingMachine {
      override async execLine(
        line: string,
        stdin: Uint8Array | null,
        env: Record<string, string>,
        cwd: string,
      ): Promise<RunResult> {
        await new Promise((resolve) => setTimeout(resolve, 500))
        return super.execLine(line, stdin, env, cwd)
      }
    }
    const box = new SlowBox({ captures: ['python3'] })
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        ...on(box, 'workspace'),
        commandLimits: { '@line': new Limit({ timeoutSeconds: 0.05 }) },
      },
    )
    try {
      // A captured line runs under the line's deadline as any other line.
      const io = await ws.shell('python3 train.py')
      expect(io.exitCode).toBe(124)
      expect(DEC.decode(io.stderr)).toContain('line: timed out after 0.05s')
    } finally {
      await ws.close()
    }
  })

  // A run cancelled midway (head closed its pipe, a timeout) may leave its
  // program running in the box, so every process it started is stopped by
  // the run's id, with one more exec that carries no id of its own.
  it('stops what a cancelled run left in the box', async () => {
    class StuckBox extends RecordingMachine {
      protected override async execArgv(
        argv: readonly string[],
        stdin: ByteSource | null,
        env: Record<string, string>,
        cwd: string,
        _output?: unknown,
        _errors?: unknown,
        signal?: AbortSignal,
      ): Promise<RunResult> {
        const result = await super.execArgv(argv, stdin, env, cwd)
        if (lineOf(argv) !== 'yes') return result
        return new Promise<RunResult>((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              reject(new DOMException('execute aborted', 'AbortError'))
            },
            { once: true },
          )
        })
      }
    }
    const box = new StuckBox({ captures: ['yes'] })
    const abort = new AbortController()
    const ctx = {
      stdin: null,
      flags: { c: 'yes' },
      env: {},
      cwd: PathSpec.fromStrPath('/'),
      signal: abort.signal,
    }
    const run = machineRuntime(box).runLine(undefined, [], [], ctx)
    const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => {
      expect(box.execs).toHaveLength(1)
    })
    abort.abort()
    await rejected
    const tag = box.execs[0]?.[2][PROCESS] ?? ''
    expect(tag).not.toBe('')
    expect(box.execs.map(([line]) => line)).toEqual(['yes', stopLine(tag)])
    expect(box.execs[1]?.[2]).not.toHaveProperty(PROCESS)
  })

  // A run a `kill` stopped is stopped in the box with the signal it named.
  it('stops a killed run in the box with its signal', async () => {
    class StuckBox extends RecordingMachine {
      protected override async execArgv(
        argv: readonly string[],
        stdin: ByteSource | null,
        env: Record<string, string>,
        cwd: string,
        _output?: unknown,
        _errors?: unknown,
        signal?: AbortSignal,
      ): Promise<RunResult> {
        const result = await super.execArgv(argv, stdin, env, cwd)
        if (lineOf(argv) !== 'yes') return result
        return new Promise<RunResult>((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              reject(new DOMException('execute aborted', 'AbortError'))
            },
            { once: true },
          )
        })
      }
    }
    const box = new StuckBox({ captures: ['yes'] })
    const abort = new AbortController()
    const ctx = {
      stdin: null,
      flags: { c: 'yes' },
      env: {},
      cwd: PathSpec.fromStrPath('/'),
      signal: abort.signal,
    }
    const runner = new ProcessTable(undefined, undefined, runAsProcess).start({
      sessionId: 's',
      command: 'yes',
      cwd: ctx.cwd,
      cancel: () => {
        abort.abort()
      },
      run: async () => (await machineRuntime(box).runLine(undefined, [], [], ctx)).exitCode,
    })
    await vi.waitFor(() => {
      expect(box.execs).toHaveLength(1)
    })
    expect(runner.terminate(2)).toBe(true)
    expect((await runner.join()).exit).toBe(130)
    expect(box.execs[0]?.[2][PROCESS]).toBe(runner.record.id.toString())
    expect(box.execs.map(([line]) => line)).toEqual([
      'yes',
      stopLine(runner.record.id.toString(), 2),
    ])
  })

  // A run in the box carries the id of the process it runs as, which a
  // workspace that outlives this one stops it by.
  it('tags a run in the box with its process', async () => {
    const box = new RecordingMachine({ captures: ['yes'] })
    const ctx = { stdin: null, flags: { c: 'yes' }, env: {}, cwd: PathSpec.fromStrPath('/') }
    const runner = new ProcessTable('w1', undefined, runAsProcess).start({
      sessionId: 's',
      command: 'yes',
      cwd: ctx.cwd,
      cancel: () => undefined,
      run: async () => (await machineRuntime(box).runLine(undefined, [], [], ctx)).exitCode,
    })
    expect((await runner.join()).exit).toBe(0)
    expect(box.execs[0]?.[2][PROCESS]).toBe(`w1:${String(FIRST_PID)}`)
  })

  // A run another workspace left is stopped by its tag, the box reached
  // first if this runtime never was. The stop says whether the box held the
  // run: a box that holds none of it answers so, and a stop that failed
  // throws, so neither counts as having stopped it.
  it.each([
    [0, true],
    [NOT_RUNNING_STATUS, false],
  ])('stops a left run by its tag (box answers %i)', async (code, held) => {
    class AnsweringBox extends RecordingMachine {
      override async execLine(
        line: string,
        stdin: Uint8Array | null,
        env: Record<string, string>,
        cwd: string,
      ): Promise<RunResult> {
        await super.execLine(line, stdin, env, cwd)
        return { stdout: new Uint8Array(), stderr: null, exitCode: code }
      }
    }
    const box = new AnsweringBox({ captures: ['yes'] })
    expect(await box.stop('t1', 15)).toBe(held)
    expect(box.connectedCount).toBe(1)
    expect(box.execs.map(([line]) => line)).toEqual([stopLine('t1', 15)])
  })

  it('answers false for a stop that failed', async () => {
    class FailingBox extends RecordingMachine {
      override execLine(): Promise<RunResult> {
        return Promise.resolve({ stdout: new Uint8Array(), stderr: null, exitCode: 127 })
      }
    }
    expect(await new FailingBox({ captures: ['yes'] }).stop('t1', 15)).toBe(false)
  })

  it('holds a cancel only so long when the box stops answering', async () => {
    class DeadBox extends RecordingMachine {
      protected override async execArgv(
        argv: readonly string[],
        stdin: ByteSource | null,
        env: Record<string, string>,
        cwd: string,
        _output?: unknown,
        _errors?: unknown,
        signal?: AbortSignal,
      ): Promise<RunResult> {
        await super.execArgv(argv, stdin, env, cwd)
        if (lineOf(argv) !== 'yes') return new Promise<RunResult>(() => undefined)
        return new Promise<RunResult>((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              reject(new DOMException('execute aborted', 'AbortError'))
            },
            { once: true },
          )
        })
      }
    }
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    const wait = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(10))
    try {
      const box = new DeadBox({ captures: ['yes'] })
      const abort = new AbortController()
      const ctx = {
        stdin: null,
        flags: { c: 'yes' },
        env: {},
        cwd: PathSpec.fromStrPath('/'),
        signal: abort.signal,
      }
      const run = machineRuntime(box).runLine(undefined, [], [], ctx)
      const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' })
      await vi.waitFor(() => {
        expect(box.execs).toHaveLength(1)
      })
      abort.abort()
      await rejected
      expect(box.execs).toHaveLength(2)
      expect(wait).toHaveBeenCalledWith(MACHINE_STOP_WAIT_SECONDS * 1000)
    } finally {
      wait.mockRestore()
    }
  })

  it('line output caps truncate with a notice', async () => {
    class ChattyBox extends RecordingMachine {
      override execLine(): Promise<RunResult> {
        return Promise.resolve({ stdout: ENC.encode('a\nb\nc\n'), stderr: null, exitCode: 0 })
      }
    }
    const box = new ChattyBox({ captures: ['python3'] })
    const guards = { python3: new Limit({ maxLines: 2 }) }
    const ws = new Workspace(
      { '/data': [new RAMVFS(), MountMode.EXEC, guards] },
      { mode: MountMode.EXEC, ...on(box, 'workspace') },
    )
    try {
      const io = await ws.shell('python3 train.py')
      expect(io.exitCode).toBe(0)
      expect(DEC.decode(io.stdout)).toBe('a\nb\n')
      expect(DEC.decode(io.stderr)).toContain('truncated at limit')
    } finally {
      await ws.close()
    }
  })

  it('a remote line expires the local listings', async () => {
    // The line may have written anywhere in its view of the workspace, so the
    // next stat or listing asks the backend again. Mirrors Python's
    // `test_remote_line_invalidates_local_read_caches`.
    const box = new RecordingMachine({ captures: ['python3'] })
    const ws = sandboxWorkspace(box)
    try {
      const mount = ws.registry.allMounts().find((m) => m.prefix === '/data/')
      if (mount === undefined) throw new Error('no /data mount')
      const stale = new FileStat({ name: 'stale.txt', type: FileType.FILE, fingerprint: 'stale' })
      await mount.indexStore.setDir('/', [['stale.txt', stale]], new Date(Date.now() + 3_600_000))
      expect((await mount.indexStore.listDir('/')).entries).toBeDefined()
      await ws.shell('python3 anything')
      expect((await mount.indexStore.listDir('/')).status).toBe(LookupStatus.EXPIRED)
    } finally {
      await ws.close()
    }
  })

  it('rejects unknown config keys', () => {
    const config = { snapshot: 'mirage-fuse' } as MachineConfig
    expect(() => new RecordingMachine({ config })).toThrow("unknown machine config key 'snapshot'")
  })
})
