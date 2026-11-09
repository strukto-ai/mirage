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
  JOB_REFUSED_STATUS,
  JOB_REMOVE,
  JOB_START,
  JOB_VIEW,
  SETSID_PROBE,
  signalLine,
  PROCESS,
  FAKETIME_PROBE_SECONDS,
  faketimeProbe,
  NOT_RUNNING_STATUS,
  MACHINE_STOP_WAIT_SECONDS,
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
import type { ProcessHandle } from '../execution/process/handle.ts'
import { RAMExecutionStore } from '../execution/ram.ts'
import { Channel } from '../shell/console/index.ts'
import { JobHandle } from '../execution/job/handle.ts'
import { MachineTable } from '../execution/machine/table.ts'
import { resumeJob } from '../workspace/executor/background.ts'
import type { OutputFn } from '../runtime/types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// The argv a sandbox runs, as the line the fakes answer.
function lineOf(argv: readonly string[]): string {
  return argv[0] === '/bin/sh' && argv[1] === '-c' ? (argv[2] ?? '') : shellJoin(argv)
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
    return this.execLine(lineOf(argv), stdin === null ? null : await materialize(stdin), env, cwd)
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

  it('lists a job whose connection dropped as killed', async () => {
    const box = new DroppedBox({ captures: ['train'] })
    const ws = sandboxWorkspace(box)
    try {
      await ws.shell('train &')
      let rows = 'running'
      while (rows.includes('running')) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        rows = DEC.decode((await ws.shell('jobs')).stdout)
      }
      expect(rows.endsWith('[1] killed train\n')).toBe(true)
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

type View = [string[], string[], number | Error | Promise<void> | RunResult]

// A box that detaches jobs, answering each viewer from `views`: the stdout
// and stderr chunks it prints, then how it ends (an exit code, an error it
// throws, or a promise it waits on).
class JobBox extends RecordingMachine {
  static override readonly detaches: boolean = true
  readonly views: View[]
  probes = 0
  readonly started: string[][] = []
  readonly viewed: string[][] = []
  readonly removed: string[] = []
  readonly startEnvs: Record<string, string>[] = []
  startCode = 0

  constructor(
    views: View[] = [],
    readonly holdsSetsid = true,
    captures?: readonly string[],
  ) {
    super(captures === undefined ? {} : { captures })
    this.views = views
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output?: OutputFn | null,
    errors?: OutputFn | null,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const script = lineOf(argv)
    if (script === JOB_START) {
      this.started.push(argv.slice(4))
      this.startEnvs.push({ ...env })
      return { stdout: new Uint8Array(), stderr: null, exitCode: this.startCode }
    }
    if (script === JOB_VIEW) {
      this.viewed.push(argv.slice(4))
      const [out, err, end] = this.views.shift() ?? [[], [], 0]
      for (const chunk of out) await output?.(ENC.encode(chunk))
      for (const chunk of err) await errors?.(ENC.encode(chunk))
      if (end instanceof Error) throw end
      if (end instanceof Promise) {
        await new Promise<void>((resolve, reject) => {
          void end.then(resolve)
          signal?.addEventListener(
            'abort',
            () => {
              reject(new DOMException('execute aborted', 'AbortError'))
            },
            { once: true },
          )
        })
        return { stdout: new Uint8Array(), stderr: null, exitCode: 0 }
      }
      if (typeof end !== 'number') return end
      return { stdout: new Uint8Array(), stderr: null, exitCode: end }
    }
    if (script === JOB_REMOVE) {
      this.removed.push(argv[4] ?? '')
      return { stdout: new Uint8Array(), stderr: null, exitCode: 0 }
    }
    return super.execArgv(argv, stdin, env, cwd)
  }

  override execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult> {
    if (line === SETSID_PROBE) {
      this.probes += 1
      return Promise.resolve({
        stdout: new Uint8Array(),
        stderr: null,
        exitCode: this.holdsSetsid ? 0 : 1,
      })
    }
    return super.execLine(line, stdin, env, cwd)
  }
}

// Run `train` on `box` as a job's process, its output streamed: the result,
// stdout and stderr, and the process.
async function jobRun(
  box: JobBox,
  options: {
    detachable?: boolean
    stdin?: Uint8Array | null
    started?: (runner: ProcessHandle) => void
    streamed?: boolean
  } = {},
): Promise<[RunResult | null, string, string, ProcessHandle]> {
  const out: Uint8Array[] = []
  const err: Uint8Array[] = []
  let done: RunResult | null = null
  const abort = new AbortController()
  const ctx = {
    stdin: options.stdin ?? null,
    flags: {},
    env: {},
    cwd: PathSpec.fromStrPath('/'),
    signal: abort.signal,
  }
  const runner = new ProcessTable('w1', undefined, runAsProcess).start({
    sessionId: 's',
    command: 'train',
    cwd: ctx.cwd,
    cancel: () => {
      abort.abort()
    },
    run: async () => {
      const streamed = options.streamed ?? true
      done = await box.run(
        ['train'],
        ctx,
        null,
        streamed
          ? (chunk) => {
              out.push(chunk)
              return Promise.resolve()
            }
          : null,
        streamed
          ? (chunk) => {
              err.push(chunk)
              return Promise.resolve()
            }
          : null,
      )
      return done.exitCode
    },
  })
  runner.detachable = options.detachable ?? true
  options.started?.(runner)
  await runner.join()
  const text = (chunks: Uint8Array[]): string => chunks.map((c) => DEC.decode(c)).join('')
  return [done, text(out), text(err), runner]
}

describe('a detached job', () => {
  // However a viewer ends without the end mark, the job is viewed again from
  // the bytes each stream delivered, so nothing comes twice or goes missing.
  it.each([
    ['a lost connection', new ConnectionLostError('closed by remote host')],
    ['an SDK error', new Error('sdk stream ended')],
    ['a transport code', 255],
    ['a clean end', 0],
  ])('is viewed again from what it delivered after %s', async (_, end) => {
    const box = new JobBox([
      [['step 0\n'], ['warn\n'], end],
      [['step 1\n'], ['\0mirage-job 3\n'], 0],
    ])
    const [done, out, err, runner] = await jobRun(box)
    expect([done?.exitCode, out, err]).toEqual([3, 'step 0\nstep 1\n', 'warn\n'])
    const folder = box.viewed[0]?.[0] ?? ''
    expect(box.viewed.map((view) => view.slice(1))).toEqual([
      ['0', '0'],
      ['7', '5'],
    ])
    expect(box.started).toEqual([[folder, runner.record.id.toString(), 'train']])
    expect(box.startEnvs[0]?.[PROCESS]).toBeUndefined()
    expect(box.removed).toEqual([folder])
  })

  // The end mark is Mirage's, never the job's: one split across reads is held
  // back, and a NUL the job wrote itself is delivered.
  it.each([
    [['warn\n\0mira', 'ge-job 0', '\n'], 'warn\n'],
    [['a\0b\n', '\0', 'mirage-job 0\n'], 'a\0b\n'],
  ])('never delivers the end mark (%j)', async (chunks, said) => {
    const box = new JobBox([[[], chunks, 0]])
    const [done, , err] = await jobRun(box)
    expect([done?.exitCode, err]).toEqual([0, said])
  })

  // A job whose wrapper went with no exit code is not left running: it ends
  // hung up, and says so.
  it('ends hung up once lost', async () => {
    const box = new JobBox([[['step 0\n'], ['\0mirage-job lost\n'], 0]])
    const [done, out, err, runner] = await jobRun(box)
    expect([done?.exitCode, out, err]).toEqual([129, 'step 0\n', ''])
    expect(DEC.decode(done?.stderr ?? new Uint8Array())).toBe(
      `mirage: ${box.id.toString()}: job lost\n`,
    )
    expect(runner.endedBy).toBe(1)
    expect(box.execs.map(([line]) => line)).toContain(stopLine(runner.record.id.toString(), 15))
    expect(box.removed).toEqual([box.viewed[0]?.[0]])
  })

  // A detached job a kill stops is stopped in the box by its tag, with the
  // signal named, and its folder goes.
  it('is stopped by its tag and its folder removed once killed', async () => {
    const box = new JobBox([[[], [], new Promise<void>(() => undefined)]])
    const [, , , runner] = await jobRun(box, {
      started: (runner) => {
        void vi
          .waitFor(() => {
            expect(box.viewed).toHaveLength(1)
          })
          .then(() => runner.terminate(15))
      },
    })
    expect(box.execs.map(([line]) => line).at(-1)).toBe(stopLine(runner.record.id.toString(), 15))
    expect(box.removed).toEqual([box.viewed[0]?.[0]])
  })

  // A signal a job takes and goes on reaches the group its detached program
  // leads, so what it started stops and continues with it.
  it('takes a signal in its group', async () => {
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const box = new JobBox([
      [[], [], gate],
      [[], ['\0mirage-job 0\n'], 0],
    ])
    const sent: boolean[] = []
    const [, , , runner] = await jobRun(box, {
      started: (runner) => {
        void vi
          .waitFor(() => {
            expect(box.viewed).toHaveLength(1)
          })
          .then(async () => {
            sent.push(await box.signal(runner.record.id.toString(), 19))
            open()
          })
      },
    })
    expect(sent).toEqual([true])
    expect(box.execs.map(([line]) => line)).toContain(
      signalLine(runner.record.id.toString(), 19, true),
    )
  })

  // Only a detachable job's program, fed no input, on a box that detaches
  // and holds setsid, detaches; any other run is one attached exec.
  it.each([
    ['not detachable', false, null, true, true],
    ['fed input', true, ENC.encode('input'), true, true],
    ['on a box that keeps jobs attached', true, null, false, true],
    ['on a box without setsid', true, null, true, false],
  ])('stays attached %s', async (_, detachable, stdin, detaches, setsid) => {
    class Box extends JobBox {
      static override readonly detaches: boolean = detaches
    }
    const box = new Box([], setsid)
    const [done, , , runner] = await jobRun(box, { detachable, stdin })
    expect([done?.exitCode, box.started]).toEqual([0, []])
    expect(box.execs.at(-1)?.[0]).toBe('train')
    expect(box.execs.at(-1)?.[2][PROCESS]).toBe(runner.record.id.toString())
  })

  it('stays attached on a machine serving mounts', async () => {
    const box = new JobBox()
    Reflect.set(box, 'mounts', {
      validate: () => Promise.resolve(null),
      guarded: (argv: readonly string[]) => argv,
      land: () => Promise.resolve([]),
    })
    const [done] = await jobRun(box)
    expect([done?.exitCode, box.started, box.probes]).toEqual([0, [], 0])
  })

  it('asks a box for setsid once', async () => {
    const box = new JobBox([
      [[], ['\0mirage-job 0\n'], 0],
      [[], ['\0mirage-job 0\n'], 0],
    ])
    await jobRun(box)
    await jobRun(box)
    expect([box.probes, box.started.length]).toEqual([1, 2])
  })

  // A background job detaches only on a store a restart reads, and only when
  // its statement redirects no output; its status reaches the console as an
  // attached job's would.
  it.each([
    ['train &', 30, true],
    ['train > /data/log &', 30, false],
    ['train &', null, false],
    ['{ train; } &', 30, false],
    ['set -x; train &', 30, false],
  ])('detaches %s on a store with lease %s: %s', async (line, lease, detached) => {
    const box = new JobBox([[['step 0\n'], ['\0mirage-job 3\n'], 0]], true, ['train'])
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC, ...on(box) })
    try {
      ws.jobTable.store = new RAMExecutionStore(lease)
      await ws.shell(line)
      const io = await ws.shell('wait %1')
      expect(box.started.length > 0).toBe(detached)
      if (detached) expect(io.exitCode).toBe(3)
    } finally {
      await ws.close()
    }
  })
})

// A workspace on `box` that another daemon may run too.
function shared(box: JobBox): Workspace {
  return new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.EXEC, workspaceId: 'shared', sessionId: 's', ...on(box) },
  )
}

describe('a daemon that takes the lease after one crashed', () => {
  // It adopts the detached job the crashed daemon left: the job keeps its
  // number, its output goes on from what its console holds with nothing
  // twice, and `wait` answers its real status.
  it('adopts a detached job', async () => {
    const store = new RAMExecutionStore(0.2)
    const first = new JobBox([[['step 0\n'], ['warn\n'], new Promise<void>(() => undefined)]])
    const old = shared(first)
    old.jobTable.store = store
    const second = new JobBox()
    second.views.push([['step 1\n'], ['\0mirage-job 3\n'], 0])
    const fresh = shared(second)
    fresh.jobTable.store = store
    try {
      await old.shell('train &', { sessionId: 's' })
      await vi.waitFor(() => {
        expect(old.jobTable.allJobs()[0]?.detached).not.toBeNull()
      })
      const [job] = old.jobTable.allJobs()
      clearTimeout(Reflect.get(old.jobTable, 'lease') as ReturnType<typeof setTimeout>)
      await new Promise((resolve) => setTimeout(resolve, 300))
      await fresh.shell('true', { sessionId: 's' })
      const [adopted] = fresh.jobTable.allJobs()
      const io = await fresh.shell('wait %1', { sessionId: 's' })
      expect(io.exitCode).toBe(3)
      expect(second.viewed[0]?.slice(1)).toEqual(['7', '5'])
      expect(adopted?.process?.record.id.pid).toBe(job?.pid)
      const [chunks] = (await adopted?.console.readFrom(0)) ?? [[]]
      const stdout = chunks.filter((c) => c.channel === Channel.STDOUT)
      expect(stdout.map((c) => DEC.decode(c.data)).join('')).toBe('step 0\nstep 1\n')
      expect(second.removed).toEqual([second.viewed[0]?.[0]])
    } finally {
      await fresh.close()
      await old.close()
    }
  })
})

// A daemon that lost the lease leaves a detached job to the daemon that
// adopts it: its run is cancelled without stopping the program or removing
// its folder.
it('leaves a released detached job running', async () => {
  const box = new JobBox([[[], [], new Promise<void>(() => undefined)]])
  const [, , , runner] = await jobRun(box, {
    started: (runner) => {
      void vi
        .waitFor(() => {
          expect(box.viewed).toHaveLength(1)
        })
        .then(() => {
          runner.released = true
          runner.terminate(1)
        })
    },
  })
  expect(runner.detached).toBe(true)
  expect(box.execs.slice(1).some(([line]) => line.startsWith('PATH='))).toBe(false)
  expect(box.removed).toEqual([])
})

// An adopted job past its line's limit is stopped in the box and ends 124
// with the line's notice, as it would have where it started.
it('ends an adopted job past its deadline 124', async () => {
  const box = new JobBox([[[], [], new Promise<void>(() => undefined)]])
  const job = new JobHandle({
    id: 1,
    command: 'train',
    cwd: '/',
    createdAt: 0,
    abort: new AbortController(),
    detached: { machine: box.id.toString(), folder: '/f', tag: 'w:9' },
    deadline: Date.now() / 1000 - 1,
    timeout: 5,
  })
  const code = await resumeJob(new MachineTable({ [box.name]: box }), job, [0, 0])
  const [chunks] = await job.console.readFrom(0)
  expect(code).toBe(124)
  expect(chunks.map((c) => DEC.decode(c.data)).join('')).toContain('line')
  expect(box.execs.at(-1)?.[0]).toBe(stopLine('w:9', 15))
  expect(box.removed).toEqual(['/f'])
})

// A start that failed returns its own status, and whatever a wrapper that
// outlived the start's wait started is stopped by its tag, its folder gone.
it('returns a failed start and stops its tag', async () => {
  const box = new JobBox()
  box.startCode = 126
  const [done, , , runner] = await jobRun(box)
  expect([done?.exitCode, box.viewed]).toEqual([126, []])
  expect(box.execs.at(-1)?.[0]).toBe(stopLine(runner.record.id.toString(), 15))
  expect(box.removed).toEqual([box.started[0]?.[0]])
})

// Output a transport returns whole, or one a dropped connection read, is kept
// and counted, so the next viewer starts after it.
it('keeps and counts output returned whole', async () => {
  const box = new JobBox([
    [[], [], new ConnectionLostError('closed', ENC.encode('a\n'), ENC.encode('w\n'))],
    [[], [], { stdout: ENC.encode('b\n'), stderr: ENC.encode('\0mirage-job 0\n'), exitCode: 0 }],
  ])
  const [done] = await jobRun(box, { streamed: false })
  expect([DEC.decode(done?.stdout), DEC.decode(done?.stderr ?? new Uint8Array())]).toEqual([
    'a\nb\n',
    'w\n',
  ])
  expect(box.viewed[1]?.slice(1)).toEqual(['2', '2'])
})

// An adopted job on a machine this workspace no longer has is lost.
it('loses an adopted job on an unknown machine', async () => {
  const job = new JobHandle({
    id: 1,
    command: 'train',
    cwd: '/',
    createdAt: 0,
    detached: { machine: 'docker:gone', folder: '/f', tag: 'w:9' },
  })
  expect(await resumeJob(new MachineTable({}), job, [0, 0])).toBe(129)
  const [chunks] = await job.console.readFrom(0)
  expect(chunks.map((c) => DEC.decode(c.data)).join('')).toBe('mirage: docker:gone: job lost\n')
})

// A start that failed past the connection may have started what nothing
// would view: it is stopped by its tag and its folder goes.
it('stops the tag of a start that failed', async () => {
  class BrokenStart extends JobBox {
    protected override async execArgv(
      argv: readonly string[],
      stdin: ByteSource | null,
      env: Record<string, string>,
      cwd: string,
      output?: OutputFn | null,
      errors?: OutputFn | null,
      signal?: AbortSignal,
    ): Promise<RunResult> {
      if (argv[2] === JOB_START) {
        this.started.push(argv.slice(4))
        throw new Error('sdk failed')
      }
      return super.execArgv(argv, stdin, env, cwd, output, errors, signal)
    }
  }
  const box = new BrokenStart()
  const [, , , runner] = await jobRun(box)
  expect(box.execs.at(-1)?.[0]).toBe(stopLine(runner.record.id.toString(), 15))
  expect(box.removed).toEqual([box.started[0]?.[0]])
})

// Output counts as delivered only once delivered: a chunk whose delivery
// failed is viewed again.
it('views again a chunk whose delivery failed', async () => {
  const box = new JobBox([
    [['step 0\n'], [], 0],
    [['step 0\n'], ['\0mirage-job 0\n'], 0],
  ])
  const out: string[] = []
  let failed = false
  const ctx = { stdin: null, flags: {}, env: {}, cwd: PathSpec.fromStrPath('/') }
  const runner = new ProcessTable('w1', undefined, runAsProcess).start({
    sessionId: 's',
    command: 'train',
    cwd: ctx.cwd,
    cancel: () => undefined,
    run: async () => {
      runner.detachable = true
      const done = await box.run(
        ['train'],
        ctx,
        null,
        (chunk) => {
          if (!failed) {
            failed = true
            return Promise.reject(new Error('console unavailable'))
          }
          out.push(DEC.decode(chunk))
          return Promise.resolve()
        },
        () => Promise.resolve(),
      )
      return done.exitCode
    },
  })
  expect((await runner.join()).exit).toBe(0)
  expect(box.viewed.map((view) => view.slice(1))).toEqual([
    ['0', '0'],
    ['0', '0'],
  ])
  expect(out.join('')).toBe('step 0\n')
})

// A box that cannot detach a job, with no folder of the user's own or no
// setsid, runs it attached, as it would any other run.
it('runs attached a job the box cannot detach', async () => {
  const box = new JobBox()
  box.startCode = JOB_REFUSED_STATUS
  const [done, , , runner] = await jobRun(box)
  expect([done?.exitCode, box.viewed]).toEqual([0, []])
  expect(box.removed).toEqual([box.started[0]?.[0]])
  expect(box.execs.at(-1)?.[0]).toBe('train')
  expect(box.execs.at(-1)?.[2][PROCESS]).toBe(runner.record.id.toString())
})
