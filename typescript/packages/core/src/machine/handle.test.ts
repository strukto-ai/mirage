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
import { ExitLineFilter, MachineHandle, PidLineFilter } from './handle.ts'
import { concat } from '../utils/bytes.ts'
import type { Context } from '../commands/config.ts'
import {
  PROCESS,
  FAKETIME_PROBE_SECONDS,
  FIFO_NAME,
  faketimeProbe,
  fifoLine,
  isRun,
  NOT_RUNNING_STATUS,
  MACHINE_STOP_WAIT_SECONDS,
  RUN_DRAIN_SECONDS,
  RUN_EXIT_MARK,
  RUN_PID_HOLD,
  RUN_PID_MARK,
  RUN_PROGRAM_AT,
  runExitMark,
  runTag,
  stopLine,
} from './constants.ts'
import { LanguageRuntime } from '../runtime/language.ts'
import { isLineExecutor } from '../runtime/mixin.ts'
import { answerOf } from '../runtime/binding.ts'
import type { OutputFn, RunAnswer, RunResult } from '../runtime/types.ts'
import type { MachineConfig } from './config.ts'
import type { RunStatus } from './types.ts'
import { ProcessTable } from '../execution/process/table.ts'
import { runAsProcess } from '../context/session_context.ts'
import { machineRuntime, on } from '../../tests/fixtures/machine.ts'
import { FIRST_PID } from '../execution/process/constants.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const EMPTY = new Uint8Array()

// What a fake box answers a line: its stdout, nothing on stderr.
function answer(stdout: Uint8Array, exitCode = 0): RunAnswer {
  return { exitCode, stdout, stderr: EMPTY }
}

// Where a run whose output a test does not read writes it.
const ignore: OutputFn = () => Promise.resolve()

// A line run on a box's remote runtime, its answer kept whole.
function lineOn(box: MachineHandle, ctx: Context): Promise<RunAnswer> {
  return answerOf((output, errors) =>
    machineRuntime(box).runLine(undefined, [], [], ctx, output, errors),
  )
}

// The argv a sandbox runs, as the line the fakes answer.
function lineOf(argv: readonly string[]): string {
  const run = isRun(argv) ? argv.slice(RUN_PROGRAM_AT) : argv
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
  ): Promise<RunAnswer> {
    this.execs.push([line, stdin, env, cwd])
    return Promise.resolve(answer(ENC.encode(`ran:${line}`)))
  }

  // Runs the line through `execLine` and writes its answer once, as a
  // transport that gets it whole does.
  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn,
    errors: OutputFn,
  ): Promise<RunResult> {
    const given = isRun(argv) ? { ...env, [PROCESS]: runTag(argv) } : env
    const done = await this.execLine(
      lineOf(argv),
      stdin === null ? null : await materialize(stdin),
      given,
      cwd,
    )
    if (done.stdout.byteLength > 0) await output(done.stdout)
    if (done.stderr.byteLength > 0) await errors(done.stderr)
    return { exitCode: done.exitCode }
  }
}

// A box that keeps what each line it runs was fed, streamed or not.
class FifoBox extends RecordingMachine {
  lost = false

  override async connect(): Promise<void> {
    await super.connect()
    this.execs.push(['connect', null, {}, '/'])
  }

  override async execLine(
    line: string,
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunAnswer> {
    const data = stdin === null ? null : await materialize(stdin)
    if (line.includes('rm -f') && this.lost) throw new Error('gone')
    const done = await super.execLine(line, data, env, cwd)
    if (!line.includes('mkfifo')) return done
    return { ...done, stdout: ENC.encode(`/home/u/.mirage/fd-${named(line)}`) }
  }
}

// The name a line making a named pipe (`fifoLine`) gives it.
function named(line: string): string {
  const marker = `"$d/${FIFO_NAME}-`
  return line.slice(line.lastIndexOf(marker) + marker.length).split('"')[0] ?? ''
}

// The one line that made a named pipe, and the path the box answered.
function fifoOf(lines: readonly string[]): [string, string] {
  const made = lines.filter((line) => line.includes('mkfifo'))
  expect(made).toHaveLength(1)
  const line = made[0] ?? ''
  expect(line).toBe(fifoLine(named(line), ['/data']))
  return [line, `/home/u/.mirage/fd-${named(line)}`]
}

// A box whose connection drops while it runs `train`, once the run has
// written a line to each stream.
class DroppedBox extends RecordingMachine {
  error: Error = new ConnectionLostError('closed by remote host')

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn,
    errors: OutputFn,
  ): Promise<RunResult> {
    const done = await super.execArgv(argv, stdin, env, cwd, ignore, ignore)
    if (!lineOf(argv).startsWith('train')) return done
    await output(ENC.encode('step 0\n'))
    await errors(ENC.encode('warn\n'))
    throw this.error
  }
}

function sandboxWorkspace(box: RecordingMachine): Workspace {
  return new Workspace(
    { '/data': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      ...on(box),
    },
  )
}

// A box that records when Mirage's work there starts and ends.
class WorkingBox extends RecordingMachine {
  readonly events: string[] = []

  override connect(): Promise<void> {
    this.events.push('connect')
    return super.connect()
  }

  protected override becameBusy(): void {
    this.events.push('busy')
  }

  protected override becameIdle(): void {
    this.events.push('idle')
  }

  // A line through the base class's own `execLine`, which counts as work.
  baseLine(line: string): Promise<RunAnswer> {
    return MachineHandle.prototype.execLine.call(this, line, null, {}, '/')
  }
}

describe('MachineHandle', () => {
  it('counts a run as work from before it connects until it ends', async () => {
    const box = new WorkingBox({ captures: ['python3'] })
    const ws = sandboxWorkspace(box)
    try {
      await ws.shell('python3 x')
      await ws.shell('python3 y')
      expect(box.events).toEqual(['busy', 'connect', 'idle', 'busy', 'idle'])
    } finally {
      await ws.close()
    }
  })

  it('counts overlapping work as one busy spell', async () => {
    const box = new WorkingBox()
    await Promise.all([box.baseLine('true'), box.baseLine('true')])
    await box.stop('tag', 15)
    expect(box.events).toEqual(['busy', 'idle', 'connect', 'busy', 'idle'])
  })

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
      ): Promise<RunAnswer> {
        if (line !== faketimeProbe()) return super.execLine(line, stdin, env, cwd)
        this.execs.push([line, stdin, env, cwd])
        const found = this.holds === '' ? '' : `${this.holds}\n`
        return Promise.resolve(answer(ENC.encode(found)))
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
          ...on(box),
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
      ): Promise<RunAnswer> {
        if (line !== faketimeProbe()) return super.execLine(line, stdin, env, cwd)
        this.probes += 1
        await new Promise((resolve) => setTimeout(resolve, 10))
        const exitCode = this.answers.shift() ?? 0
        return answer(ENC.encode('/usr/lib/faketime/libfaketime.so.1\n'), exitCode)
      }
    }
    const box = new CountedBox()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.EXEC, ...on(box), systemTime: '2026-03-02T09:00:00Z' },
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
      ): Promise<RunAnswer> {
        if (line !== faketimeProbe()) return super.execLine(line, stdin, env, cwd)
        this.probes += 1
        if (this.probes === 1) return new Promise(() => undefined)
        return Promise.resolve(answer(ENC.encode('/usr/lib/faketime/libfaketime.so.1\n')))
      }
    }
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    const spy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => timeout(ms === FAKETIME_PROBE_SECONDS * 1000 ? 20 : ms))
    const box = new StalledBox()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.EXEC, ...on(box), systemTime: '2026-03-02T09:00:00Z' },
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
    const result = await lineOn(box, {
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
      expect(DEC.decode(io.stderr)).toBe(`warn\nmirage: ${String(box.machine)}: connection lost\n`)
    } finally {
      await ws.close()
    }
  })

  // What a dropped run wrote before the drop reached its sinks as it came;
  // the drop's own line follows on stderr.
  it('keeps what a dropped run wrote', async () => {
    const box = new DroppedBox({ captures: ['train'] })
    const ran = await lineOn(box, {
      flags: { c: 'train' },
      stdin: null,
      cwd: PathSpec.fromStrPath('/'),
    })
    expect([ran.exitCode, DEC.decode(ran.stdout), DEC.decode(ran.stderr)]).toEqual([
      129,
      'step 0\n',
      `warn\nmirage: ${String(box.machine)}: connection lost\n`,
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
      ): Promise<RunAnswer> {
        await new Promise((resolve) => setTimeout(resolve, 500))
        return super.execLine(line, stdin, env, cwd)
      }
    }
    const box = new SlowBox({ captures: ['python3'] })
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        ...on(box),
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
        output: OutputFn,
        errors: OutputFn,
        signal?: AbortSignal,
      ): Promise<RunResult> {
        const result = await super.execArgv(argv, stdin, env, cwd, output, errors)
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
    const run = machineRuntime(box).runLine(undefined, [], [], ctx, ignore, ignore)
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
        output: OutputFn,
        errors: OutputFn,
        signal?: AbortSignal,
      ): Promise<RunResult> {
        const result = await super.execArgv(argv, stdin, env, cwd, output, errors)
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
      run: async () =>
        (await machineRuntime(box).runLine(undefined, [], [], ctx, ignore, ignore)).exitCode,
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
      run: async () =>
        (await machineRuntime(box).runLine(undefined, [], [], ctx, ignore, ignore)).exitCode,
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
      ): Promise<RunAnswer> {
        await super.execLine(line, stdin, env, cwd)
        return answer(EMPTY, code)
      }
    }
    const box = new AnsweringBox({ captures: ['yes'] })
    expect(await box.stop('t1', 15)).toBe(held)
    expect(box.connectedCount).toBe(1)
    expect(box.execs.map(([line]) => line)).toEqual([stopLine('t1', 15)])
  })

  it('answers false for a stop that failed', async () => {
    class FailingBox extends RecordingMachine {
      override execLine(): Promise<RunAnswer> {
        return Promise.resolve(answer(EMPTY, 127))
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
        output: OutputFn,
        errors: OutputFn,
        signal?: AbortSignal,
      ): Promise<RunResult> {
        await super.execArgv(argv, stdin, env, cwd, output, errors)
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
      const run = machineRuntime(box).runLine(undefined, [], [], ctx, ignore, ignore)
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

  // An answer the transport got whole streams through the run's stdout like
  // any other, so a cap that stops reading stops the run before it settles,
  // 141 as SIGPIPE leaves a program.
  it('line output caps truncate with a notice', async () => {
    class ChattyBox extends RecordingMachine {
      override execLine(): Promise<RunAnswer> {
        return Promise.resolve(answer(ENC.encode('a\nb\nc\n')))
      }
    }
    const box = new ChattyBox({ captures: ['python3'] })
    const guards = { python3: new Limit({ maxLines: 2 }) }
    const ws = new Workspace(
      { '/data': [new RAMVFS(), MountMode.EXEC, guards] },
      { mode: MountMode.EXEC, ...on(box) },
    )
    try {
      const io = await ws.shell('python3 train.py')
      expect(io.exitCode).toBe(141)
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

async function filtered(
  chunks: readonly Uint8Array[],
  search: boolean,
): Promise<[string, RunStatus[]]> {
  const out: Uint8Array[] = []
  const seen: RunStatus[] = []
  const line = new PidLineFilter(
    (chunk) => Promise.resolve(void out.push(chunk)),
    (report) => seen.push(report),
    search,
  )
  for (const chunk of chunks) await line.write(chunk)
  await line.finish()
  return [out.map((chunk) => DEC.decode(chunk)).join(''), seen]
}

describe('PidLineFilter', () => {
  // stderr may carry the exec client's own words ahead of the pid line,
  // which can arrive in pieces; the line comes out and its pid and start are
  // told.
  it("takes the pid line out of stderr after the client's words", async () => {
    const chunks = [
      ENC.encode('Defaulted container\n'),
      RUN_PID_MARK.subarray(0, 4),
      new Uint8Array([...RUN_PID_MARK.subarray(4), ...ENC.encode('81')]),
      ENC.encode('2 99\nerr\n'),
    ]
    expect(await filtered(chunks, true)).toEqual([
      'Defaulted container\nerr\n',
      [{ pid: 812, started: 99 }],
    ])
  })

  // stdout carries the line only at its very start; anything else passes at
  // once, and a line further in is the program's own.
  it('gives up the pid line from stdout only at its start', async () => {
    const head = new Uint8Array([...RUN_PID_MARK, ...ENC.encode('7 1\nout')])
    expect(await filtered([head], false)).toEqual(['out', [{ pid: 7, started: 1 }]])
    const late = new Uint8Array([...ENC.encode('x'), ...RUN_PID_MARK, ...ENC.encode('7 1\n')])
    expect(await filtered([late], false)).toEqual([DEC.decode(late), []])
  })

  // A run whose wrapper wrote no line keeps every byte it wrote, released at
  // once past the most stderr may hold, else when the stream ends.
  it('keeps every byte of a stream with no pid line', async () => {
    expect(await filtered([ENC.encode('only err')], true)).toEqual(['only err', []])
    const big = 'e'.repeat(RUN_PID_HOLD + 1)
    expect(await filtered([ENC.encode(big), ENC.encode('!')], true)).toEqual([`${big}!`, []])
  })
})

const MARK = runExitMark('n1')

async function exited(chunks: readonly Uint8Array[]): Promise<[string, number[]]> {
  const out: Uint8Array[] = []
  const codes: number[] = []
  const line = new ExitLineFilter(
    (chunk) => Promise.resolve(void out.push(chunk)),
    (code) => codes.push(code),
    MARK,
  )
  for (const chunk of chunks) await line.write(chunk)
  await line.finish()
  return [out.map((chunk) => DEC.decode(chunk)).join(''), codes]
}

describe('ExitLineFilter', () => {
  // The exit line can arrive in pieces; it comes out and its status is told,
  // and what the program left running writes after it passes.
  it('takes the exit line out and gives the status', async () => {
    const chunks = [
      ENC.encode('err\n'),
      MARK.subarray(0, 4),
      new Uint8Array([...MARK.subarray(4), ...ENC.encode('4')]),
      ENC.encode('2\nlater\n'),
    ]
    expect(await exited(chunks)).toEqual(['err\nlater\n', [42]])
  })

  // The status is told once the output written with the line has been taken,
  // so a slow reader never has the run let go mid-write.
  it('tells the status once the output written with it is taken', async () => {
    let release = (): void => undefined
    const taken = new Promise<void>((resolve) => {
      release = resolve
    })
    const codes: number[] = []
    const line = new ExitLineFilter(
      () => taken,
      (code) => codes.push(code),
      MARK,
    )
    const writing = line.write(
      new Uint8Array([...ENC.encode('out\n'), ...MARK, ...ENC.encode('0\n')]),
    )
    await Promise.resolve()
    expect(codes).toEqual([])
    release()
    await writing
    expect(codes).toEqual([0])
  })

  // A mark with no status line after it is the program's own, and so is a
  // piece of one the stream ends on.
  it("leaves a mark without a status line as the program's own", async () => {
    const own = `x${DEC.decode(MARK)}abc\n`
    expect(await exited([ENC.encode(own)])).toEqual([own, []])
    const long = `${DEC.decode(MARK)}1234\n`
    expect(await exited([ENC.encode(long)])).toEqual([long, []])
    const piece = `y${DEC.decode(MARK.subarray(0, 3))}`
    expect(await exited([ENC.encode(piece)])).toEqual([piece, []])
  })

  // Only the run's own word makes a line its exit: a program that writes the
  // mark itself, with another word or none, ends nothing.
  it("leaves an exit line without the run's own word as the program's", async () => {
    const forged = `${DEC.decode(RUN_EXIT_MARK)}0\n${DEC.decode(runExitMark('other'))}0\n`
    expect(await exited([ENC.encode(forged)])).toEqual([forged, []])
  })
})

// A box whose program exits while what it left running holds the exec open.
class LeftOpenBox extends RecordingMachine {
  protected override async execArgv(
    argv: readonly string[],
    _stdin: ByteSource | null,
    _env: Record<string, string>,
    _cwd: string,
    _output: OutputFn,
    errors: OutputFn,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const mark = runExitMark(argv[RUN_PROGRAM_AT - 2] ?? '')
    await errors(new Uint8Array([...mark, ...ENC.encode('3\n')]))
    return new Promise((_, reject) => {
      signal?.addEventListener('abort', () => {
        reject(new Error('let go'))
      })
    })
  }
}

// A program that exits while what it left running holds the exec open ends
// with the status its exit line gave, without waiting for the exec.
it('ends a run on its exit line while the exec stays open', async () => {
  const box = new LeftOpenBox({ captures: ['train'] })
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC, ...on(box) })
  try {
    const io = await ws.shell('train')
    expect(io.exitCode).toBe(3)
    expect(DEC.decode(await materialize(io.stderr))).toBe('')
  } finally {
    await ws.close()
  }
}, 5000)

// A box whose program, once stopped, exits 0 by its own trap while the exec
// takes longer than the drain to answer the stop.
class SlowStopBox extends RecordingMachine {
  started = false

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn,
    errors: OutputFn,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    if (!isRun(argv)) return super.execArgv(argv, stdin, env, cwd, output, errors)
    this.started = true
    await new Promise<void>((resolve) => {
      signal?.addEventListener('abort', () => {
        resolve()
      })
    })
    const mark = runExitMark(argv[RUN_PROGRAM_AT - 2] ?? '')
    await errors(new Uint8Array([...mark, ...ENC.encode('0\n')]))
    await new Promise((resolve) => setTimeout(resolve, (RUN_DRAIN_SECONDS + 0.3) * 1000))
    throw new DOMException('execute aborted', 'AbortError')
  }
}

// A run a kill stopped ends as stopped, even when its program says it exited
// 0 while the stop is still under way.
it('ends a stopped run as stopped whatever its program said meanwhile', async () => {
  const box = new SlowStopBox()
  const abort = new AbortController()
  const ctx = {
    stdin: null,
    flags: { c: 'train' },
    env: {},
    cwd: PathSpec.fromStrPath('/'),
    signal: abort.signal,
  }
  const runner = new ProcessTable(undefined, undefined, runAsProcess).start({
    sessionId: 's',
    command: 'train',
    cwd: ctx.cwd,
    cancel: () => {
      abort.abort()
    },
    run: async () =>
      (await machineRuntime(box).runLine(undefined, [], [], ctx, ignore, ignore)).exitCode,
  })
  await vi.waitFor(() => {
    expect(box.started).toBe(true)
  })
  expect(runner.terminate(2)).toBe(true)
  expect((await runner.join()).exit).toBe(130)
}, 5000)

// A box that writes the run's pid and exit lines as its wrapper would: on
// stderr when its streams are apart, on stdout, around the program's own,
// when its exec joins them (`joinsStreams`, as Daytona's does).
class PidLineBox extends RecordingMachine {
  override readonly joinsStreams: boolean

  constructor(joined: boolean) {
    super({ captures: ['train'] })
    this.joinsStreams = joined
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn,
    errors: OutputFn,
  ): Promise<RunResult> {
    const own: Uint8Array[] = []
    const keep: OutputFn = (data) => Promise.resolve(void own.push(data))
    await super.execArgv(argv, stdin, env, cwd, keep, ignore)
    const line = new Uint8Array([...RUN_PID_MARK, ...ENC.encode('812 99\n')])
    const exit = new Uint8Array([...runExitMark(argv[RUN_PROGRAM_AT - 2] ?? ''), 0x30, 0x0a])
    if (this.joinsStreams) {
      await output(concat([line, ...own]))
      await output(exit)
      return { exitCode: 0 }
    }
    await errors(line)
    await output(new Uint8Array([...RUN_PID_MARK, ...ENC.encode('7 1\nmine\n')]))
    await errors(exit)
    return { exitCode: 0 }
  }
}

// The wrapper's pid line comes on stderr, so a program's own stdout that
// starts like it is left whole; an exec that joins its streams brings the
// pid line at the start of stdout and the exit line after the program's
// output, and both come off it. Either way the first line gives the
// program's pid.
it.each([
  [false, `${DEC.decode(RUN_PID_MARK)}7 1\nmine\n`],
  [true, 'ran:train'],
])('gives the program its pid from the first pid line (joined %s)', async (joined, stdout) => {
  const box = new PidLineBox(joined)
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC, ...on(box) })
  try {
    const io = await ws.shell('train')
    expect(DEC.decode(await materialize(io.stdout))).toBe(stdout)
    expect(DEC.decode(await materialize(io.stderr))).toBe('')
    const [program] = (await ws.processes()).filter((p) => p.program)
    expect([program?.machinePid?.pid, program?.machineInstance]).toEqual([812, 'box'])
  } finally {
    await ws.close()
  }
})

// A process substitution a program reads by path becomes a named pipe on the
// program's machine, only its owner's, made once the machine is reached, fed
// what the substitution writes, then removed; one it writes to stays its word.
it('turns a substitution a program names into a pipe on its machine', async () => {
  const box = new FifoBox({ captures: ['node'] })
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC, ...on(box) })
  try {
    const io = await ws.shell('node read.js <(echo hi) /dev/fd/9 >(cat)')
    expect(io.exitCode).toBe(0)
  } finally {
    await ws.close()
  }
  const lines = box.execs.map(([line]) => line)
  const [made, fifo] = fifoOf(lines)
  const ran = lines.indexOf(`node read.js ${fifo} /dev/fd/9 /dev/fd/62`)
  expect(lines.indexOf('connect')).toBeLessThan(lines.indexOf(made))
  expect(lines.indexOf(made)).toBeLessThan(ran)
  const fed = box.execs
    .filter(([line]) => line.includes('exec cat'))
    .map(([line, data]) => [line, DEC.decode(data ?? new Uint8Array())])
  expect(fed).toEqual([[`[ -p ${fifo} ] && exec cat > ${fifo}`, 'hi\n']])
  expect(lines.indexOf(`exec 3<>${fifo}; exec 3>&-; rm -f ${fifo}`)).toBeGreaterThan(ran)
})

// A function's program reads the substitution its call was given.
it("pipes a call's substitution to its function's program", async () => {
  const box = new FifoBox({ captures: ['node'] })
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC, ...on(box) })
  try {
    const io = await ws.shell('f() { node read.js "$1"; }; f <(echo hi)')
    expect(io.exitCode).toBe(0)
  } finally {
    await ws.close()
  }
  const lines = box.execs.map(([line]) => line)
  const [, fifo] = fifoOf(lines)
  expect(lines).toContain(`node read.js ${fifo}`)
})

// A pipe that cannot be removed, the machine gone, leaves the program's output
// as it ran.
it('keeps the output of a program whose pipe is left behind', async () => {
  const box = new FifoBox({ captures: ['node'] })
  box.lost = true
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC, ...on(box) })
  try {
    const io = await ws.shell('node read.js <(echo hi)')
    expect(io.exitCode).toBe(0)
    expect(DEC.decode(await materialize(io.stdout))).toMatch(/^ran:node read\.js /)
  } finally {
    await ws.close()
  }
})

class HungBox extends RecordingMachine {
  override connect(): Promise<void> {
    return new Promise(() => undefined)
  }
}

describe('MachineHandle close', () => {
  it('never waits for a hung connect on a machine that cannot pause', async () => {
    const box = new HungBox()
    void box.ensureConnected().catch(() => undefined)
    await expect(
      Promise.race([
        box.close().then(() => 'closed'),
        new Promise((resolve) => setTimeout(resolve, 1000, 'stuck')),
      ]),
    ).resolves.toBe('closed')
  })
})

describe('hasProgram', () => {
  it('asks the machine once per name', async () => {
    const machine = new RecordingMachine()
    expect(await machine.hasProgram('grep')).toBe(true)
    expect(await machine.hasProgram('grep')).toBe(true)
    expect(machine.execs.map(([line]) => line)).toEqual(['command -v grep >/dev/null 2>&1'])
  })
})
