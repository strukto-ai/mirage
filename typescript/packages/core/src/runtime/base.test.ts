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

import { describe, expect, it } from 'vitest'
import type { Context } from '../commands/config.ts'
import { currentCaller } from '../context/session_context.ts'
import type { Process } from '../execution/process/types.ts'
import { MachineName } from '../execution/types.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import { Runtime } from './base.ts'
import { PROCESS_EXECUTOR, type ProcessExecutorMixin } from './mixin.ts'
import type { RunResult, RuntimeReach } from './types.ts'

const DEC = new TextDecoder()

class StubEngine {
  readonly name = 'stub'
}

class SlowCloseRuntime extends Runtime<StubEngine> {
  readonly name = 'slow-close'
  closed = 0
  release!: () => void
  readonly entered: Promise<void>
  private markEntered!: () => void

  constructor() {
    super()
    this.entered = new Promise((resolve) => {
      this.markEntered = resolve
    })
  }

  protected override openEngine(): Promise<StubEngine> {
    return Promise.resolve(new StubEngine())
  }

  protected override async closeEngine(_engine: StubEngine): Promise<void> {
    this.markEntered()
    await new Promise<void>((resolve) => {
      this.release = resolve
    })
    this.closed += 1
  }
}

describe('Runtime.close', () => {
  it('a second close waits for the engine the first is closing', async () => {
    const rt = new SlowCloseRuntime()
    await rt.engine()
    const first = rt.close()
    await rt.entered
    let secondDone = false
    const second = rt.close().then(() => {
      secondDone = true
    })
    await Promise.resolve()
    expect(secondDone).toBe(false)
    rt.release()
    await Promise.all([first, second])
    expect(rt.closed).toBe(1)
  })
})

/**
 * A runtime past the workspace's reach, on machine `box:b1`, that keeps the
 * record of the process each program it runs runs as, and holds one named
 * `hold` until `release` or its stop.
 */
class SeenRuntime extends Runtime implements ProcessExecutorMixin {
  readonly [PROCESS_EXECUTOR] = true as const
  readonly name = 'seen'
  readonly seen: Process[] = []
  release!: () => void
  private readonly released = new Promise<void>((resolve) => {
    this.release = resolve
  })

  constructor(override readonly reach: RuntimeReach = 'remote') {
    super({}, ['probe', 'hold'])
  }

  override get machine(): MachineName {
    return new MachineName('box', 'b1')
  }

  async runProcess(
    _engine: unknown,
    _paths: unknown,
    texts: string[],
    ctx: Context,
  ): Promise<RunResult> {
    const process = currentCaller().process
    if (process == null) throw new Error('no process')
    this.seen.push(process.record)
    if (texts[0] === 'hold') {
      const stopped = new Promise<never>((_resolve, reject) => {
        ctx.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
      await Promise.race([this.released, stopped])
    }
    return { stdout: new Uint8Array(), stderr: null, exitCode: 0 }
  }
}

async function seen(line: string, reach: RuntimeReach = 'remote'): Promise<[Process, string]> {
  const runtime = new SeenRuntime(reach)
  const ws = new Workspace({ '/data': new RAMVFS() }, { machines: [runtime] })
  try {
    const out = DEC.decode((await ws.shell(line)).stdout)
    const [process, ...more] = runtime.seen
    if (process === undefined || more.length > 0) throw new Error('not one program ran')
    return [process, out]
  } finally {
    await ws.close()
  }
}

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
}

describe('Runtime.execute', () => {
  // A program a runtime runs past the workspace is a process of its own on
  // the runtime's machine: a pipeline stage's when it is the stage's, a job's
  // when it is the job's, including one `exec` replaces, as bash execs it
  // there; a child of its shell otherwise, the session's shell staying across
  // its lines, and of `find` and `xargs`, which fork each one.
  it('runs a program past the workspace as a process of its own', async () => {
    const box = new MachineName('box', 'b1')
    const [alone, line] = await seen('probe; echo $$')
    expect([alone.parent, alone.command, alone.machine, alone.program]).toEqual([
      Number(line),
      'probe',
      box,
      true,
    ])
    const [stage, shell] = await seen('echo $$; probe | cat')
    expect([stage.parent, stage.command, stage.program]).toEqual([Number(shell), 'probe', true])
    const [job, pid] = await seen('probe & echo $!; wait')
    expect([job.id.pid, job.program]).toEqual([Number(pid), true])
    const [replaced, execd] = await seen('exec probe & echo $!; wait')
    expect([replaced.id.pid, replaced.program]).toEqual([Number(execd), true])
    const [forked, found] = await seen('find /data -maxdepth 0 -exec probe {} \\; & echo $!; wait')
    expect([forked.parent, forked.program]).toEqual([Number(found), true])
    const [batched, xargs] = await seen('/usr/bin/xargs probe </dev/null & echo $!; wait')
    expect([batched.parent, batched.program]).toEqual([Number(xargs), true])
  })

  // A runtime the workspace reaches runs its program in its shell's process.
  it('keeps a program the workspace reaches in its shell', async () => {
    const [process, line] = await seen('echo $$; probe', 'workspace')
    expect([process.id.pid, process.program]).toEqual([Number(line), false])
  })

  // A program's process stopped with its shell ends by the shell's signal.
  it("ends a program's process by its shell's signal", async () => {
    const runtime = new SeenRuntime()
    const ws = new Workspace({ '/data': new RAMVFS() }, { machines: [runtime] })
    try {
      const line = ws.shell('true; hold')
      await until(() => runtime.seen.length > 0)
      const ran = runtime.seen[0]
      const shell = ws.processTable.live().find((p) => p.record.id.pid === ran?.parent)
      const program = ws.processTable.live().find((p) => p.record.id.pid === ran?.id.pid)
      expect(shell?.terminate(15)).toBe(true)
      const ended = await program?.join()
      expect([ended?.exit, ended?.signal]).toEqual([143, 15])
      expect((await line).exitCode).toBe(143)
    } finally {
      runtime.release()
      await ws.close()
    }
  })

  // A program's process stopped alone answers 128 plus the signal, and its
  // shell goes on.
  it("leaves the shell running when a program's process is stopped alone", async () => {
    const runtime = new SeenRuntime()
    const ws = new Workspace({ '/data': new RAMVFS() }, { machines: [runtime] })
    try {
      const line = ws.shell('true; hold; echo after $?')
      await until(() => runtime.seen.length > 0)
      const ran = runtime.seen[0]
      const program = ws.processTable.live().find((p) => p.record.id.pid === ran?.id.pid)
      expect(program?.terminate(15)).toBe(true)
      const done = await line
      expect([done.exitCode, DEC.decode(done.stdout)]).toEqual([0, 'after 143\n'])
    } finally {
      runtime.release()
      await ws.close()
    }
  })
})
