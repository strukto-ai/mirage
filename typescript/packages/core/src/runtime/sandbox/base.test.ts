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
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { FileStat, FileType, Limit, MountMode, PathSpec } from '../../types.ts'
import { LookupStatus } from '../../cache/index/config.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { materialize, type ByteSource } from '../../io/types.ts'
import { shellJoin } from '../../shell/join.ts'
import { RemoteSandbox } from './base.ts'
import { EXEC_ID, REAP_WAIT_SECONDS, reapLine } from './constants.ts'
import { LanguageRuntime } from '../language.ts'
import { isLineExecutor } from '../mixin.ts'
import type { RunResult } from '../types.ts'
import type { RuntimeOptions } from '../config.ts'
import { ProcessTable } from '../../process/table.ts'
import type { ProcessHandle } from '../../process/handle.ts'
import { runWithExecution } from '../../context/session_context.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// The argv a sandbox runs, as the line the fakes answer.
function lineOf(argv: readonly string[]): string {
  return argv[0] === '/bin/sh' && argv[1] === '-c' ? (argv[2] ?? '') : shellJoin(argv)
}

class RecordingSandbox extends RemoteSandbox {
  readonly name = 'recbox'
  readonly execs: [string, Uint8Array | null, Record<string, string>, string][] = []
  connectedCount = 0

  constructor(options: RuntimeOptions = {}) {
    super(options)
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

function sandboxWorkspace(box: RecordingSandbox): Workspace {
  return new Workspace(
    { '/data': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      runtimes: [box, 'workspace'],
    },
  )
}

describe('RemoteSandbox', () => {
  it.each(['python3 --version', 'python -V', 'node --version', 'node -v', 'tsc --version'])(
    'passes %s and its output through the remote environment',
    async (line) => {
      const box = new RecordingSandbox({ captures: line.split(' ', 1) })
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

  it('connects on the first line only', async () => {
    const box = new RecordingSandbox({ captures: ['python3'] })
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
    class FlakyBox extends RecordingSandbox {
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

  it('passes cwd through verbatim and merges env', async () => {
    const box = new RecordingSandbox({ captures: ['@line'], config: { env: { BASE: '1' } } })
    const result = await box.runLine(undefined, [], [], {
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
    const box = new RecordingSandbox({ captures: ['@line'] })
    const ws = sandboxWorkspace(box)
    try {
      await ws.shell('wc -l', { stdin: ENC.encode('a\nb\n') })
      const [, stdin] = box.execs[box.execs.length - 1] ?? ['', null, {}, '']
      expect(DEC.decode(stdin ?? new Uint8Array())).toBe('a\nb\n')
    } finally {
      await ws.close()
    }
  })

  it('sandboxes take lines, not stages', () => {
    // A sandbox is a line executor, never the engine inside one
    // command: it carries the line entry point and no interpreter entry point.
    const box = new RecordingSandbox()
    expect(isLineExecutor(box)).toBe(true)
    expect(box).not.toBeInstanceOf(LanguageRuntime)
  })

  it('a line timeout answers 124', async () => {
    class SlowBox extends RecordingSandbox {
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
        runtimes: [box, 'workspace'],
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
    class StuckBox extends RecordingSandbox {
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
    const run = box.runLine(undefined, [], [], ctx)
    const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => {
      expect(box.execs).toHaveLength(1)
    })
    abort.abort()
    await rejected
    const execId = box.execs[0]?.[2][EXEC_ID] ?? ''
    expect(execId).not.toBe('')
    expect(box.execs.map(([line]) => line)).toEqual(['yes', reapLine(execId)])
    expect(box.execs[1]?.[2]).not.toHaveProperty(EXEC_ID)
  })

  // A run a `kill` stopped is stopped in the box with the signal it named.
  it('stops a killed run in the box with its signal', async () => {
    class StuckBox extends RecordingSandbox {
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
    const runner = new ProcessTable(runWithExecution).start({
      sessionId: 's',
      command: 'yes',
      cwd: ctx.cwd,
      cancel: () => {
        abort.abort()
      },
      run: async () => (await box.runLine(undefined, [], [], ctx)).exitCode,
    })
    await vi.waitFor(() => {
      expect(box.execs).toHaveLength(1)
    })
    expect(runner.terminate(2)).toBe(true)
    expect((await runner.join()).exitCode).toBe(130)
    const execId = box.execs[0]?.[2][EXEC_ID] ?? ''
    expect(box.execs.map(([line]) => line)).toEqual(['yes', reapLine(execId, 2)])
  })

  // A run in the box is one its runner has going, by its runtime and tag,
  // so the process plane lists it and a workspace that outlives this one
  // stops it; it goes once the run ends.
  it('keeps a run in the box on its runner while it runs', async () => {
    const seen: Record<string, unknown>[] = []
    let runner: ProcessHandle | null = null
    class WatchedBox extends RecordingSandbox {
      override execLine(
        line: string,
        stdin: Uint8Array | null,
        env: Record<string, string>,
        cwd: string,
      ): Promise<RunResult> {
        seen.push({ ...runner?.runs })
        return super.execLine(line, stdin, env, cwd)
      }
    }
    const box = new WatchedBox({ captures: ['yes'] })
    const ctx = { stdin: null, flags: { c: 'yes' }, env: {}, cwd: PathSpec.fromStrPath('/') }
    runner = new ProcessTable(runWithExecution).start({
      sessionId: 's',
      command: 'yes',
      cwd: ctx.cwd,
      cancel: () => undefined,
      run: async () => (await box.runLine(undefined, [], [], ctx)).exitCode,
    })
    expect((await runner.join()).exitCode).toBe(0)
    const tag = box.execs[0]?.[2][EXEC_ID] ?? ''
    expect(seen).toEqual([
      { [`box:${tag}`]: { runtime: 'recbox', tag, command: '/bin/sh -c yes' } },
    ])
    expect(runner.runs).toEqual({})
  })

  // A run another workspace left is stopped by its tag, the box reached
  // first if this runtime never was.
  it('reaps a left run by its tag', async () => {
    const box = new RecordingSandbox({ captures: ['yes'] })
    await box.reap('t1', 15)
    expect(box.connectedCount).toBe(1)
    expect(box.execs.map(([line]) => line)).toEqual([reapLine('t1', 15)])
  })

  it('holds a cancel only so long when the box stops answering', async () => {
    class DeadBox extends RecordingSandbox {
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
      const run = box.runLine(undefined, [], [], ctx)
      const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' })
      await vi.waitFor(() => {
        expect(box.execs).toHaveLength(1)
      })
      abort.abort()
      await rejected
      expect(box.execs).toHaveLength(2)
      expect(wait).toHaveBeenCalledWith(REAP_WAIT_SECONDS * 1000)
    } finally {
      wait.mockRestore()
    }
  })

  it('line output caps truncate with a notice', async () => {
    class ChattyBox extends RecordingSandbox {
      override execLine(): Promise<RunResult> {
        return Promise.resolve({ stdout: ENC.encode('a\nb\nc\n'), stderr: null, exitCode: 0 })
      }
    }
    const box = new ChattyBox({ captures: ['python3'] })
    const guards = { python3: new Limit({ maxLines: 2 }) }
    const ws = new Workspace(
      { '/data': [new RAMVFS(), MountMode.EXEC, guards] },
      { mode: MountMode.EXEC, runtimes: [box, 'workspace'] },
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
    const box = new RecordingSandbox({ captures: ['python3'] })
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
    const options = { config: { snapshot: 'mirage-fuse' } } as Record<string, unknown>
    expect(() => new RecordingSandbox(options)).toThrow("unknown runtime config key 'snapshot'")
  })
})
