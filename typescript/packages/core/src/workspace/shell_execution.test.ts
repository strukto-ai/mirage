import { describe, expect, it } from 'vitest'
import { CHUNK_SIZE } from '../io/cooperative.ts'
import type { Policy } from '../policy/base.ts'
import type { Action, ExecuteResultContext } from '../policy/types.ts'
import { JobConsole } from '../shell/console/job_console.ts'
import { Channel } from '../shell/console/types.ts'
import { LineHandle } from '../execution/line/handle.ts'
import type { ProcessHandle } from '../execution/process/handle.ts'
import { LineId } from '../execution/types.ts'
import { ShellExecution } from './shell_execution.ts'
import { ExecuteResult } from './workspace/types.ts'
import { Workspace } from './workspace/workspace.ts'

const enc = new TextEncoder()
const empty = (): ExecuteResult => new ExecuteResult(new Uint8Array(), new Uint8Array(), 0)

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

class ApproveOutput implements Policy {
  postExecute(_ctx: ExecuteResultContext): Action | null {
    return null
  }
}

class StuckSink extends JobConsole {
  private entered!: () => void
  readonly reached = new Promise<void>((resolve) => {
    this.entered = resolve
  })

  override emit(): Promise<void> {
    this.entered()
    return new Promise<void>(() => undefined)
  }
}

describe('ShellExecution', () => {
  it('awaits the event observer while collecting exact output', async () => {
    const entered = gate(),
      release = gate()
    let finished = false
    const seen: string[] = []
    const execution = new ShellExecution(
      async (output) => {
        await output.emit(Channel.STDOUT, new Uint8Array(CHUNK_SIZE * 8).fill(97))
        await output.emit(Channel.STDERR, enc.encode('warning'))
        finished = true
        return new ExecuteResult(new Uint8Array(), new Uint8Array(), 7)
      },
      new LineHandle(new LineId('line'), 's', 'c'),
    )
    const collecting = execution.collect(async (event) => {
      seen.push(event.stream)
      if (seen.length === 1) {
        entered.release()
        await release.promise
      }
    })
    try {
      await entered.promise
      expect(seen).toEqual(['stdout'])
      expect(finished).toBe(false)
      release.release()
      const result = await collecting
      expect(result.stdout).toEqual(new Uint8Array(CHUNK_SIZE * 8).fill(97))
      expect(result.stderrText).toBe('warning')
      expect(result.exitCode).toBe(7)
      expect(seen).toEqual([...Array<string>(8).fill('stdout'), 'stderr'])
      expect((await execution.wait()).stdout.byteLength).toBe(0)
    } finally {
      release.release()
      await execution.close()
      await Promise.allSettled([collecting])
    }
  })

  it('joins producer cleanup after the event observer fails', async () => {
    let closed = false
    const observed: Uint8Array[] = []
    const execution = new ShellExecution(
      async (output, signal) => {
        try {
          await output.emit(Channel.STDOUT, enc.encode('prefix'))
          await new Promise<void>((_, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                reject(new DOMException('aborted', 'AbortError'))
              },
              { once: true },
            )
          })
          return empty()
        } finally {
          closed = true
        }
      },
      new LineHandle(new LineId('line'), 's', 'c'),
    )
    await expect(
      execution.collect((event) => {
        observed.push(event.data)
        return Promise.reject(new Error('preview failed'))
      }),
    ).rejects.toThrow('preview failed')
    expect(observed).toEqual([enc.encode('prefix')])
    expect(closed).toBe(true)
    await expect(execution.wait()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('bounds output and keeps final status separate from collection', async () => {
    const started = gate()
    let finished = false
    const execution = new ShellExecution(
      async (output) => {
        started.release()
        await output.emit(Channel.STDOUT, new Uint8Array(CHUNK_SIZE * 8).fill(97))
        await output.emit(Channel.STDERR, enc.encode('warning'))
        await output.emit(Channel.STDOUT, enc.encode('tail'))
        finished = true
        return new ExecuteResult(new Uint8Array(), new Uint8Array(), 7)
      },
      new LineHandle(new LineId('line'), 's', 'c'),
    )
    await started.promise
    expect(finished).toBe(false)
    const result = await execution.collect()
    expect(result.stdout.byteLength).toBe(CHUNK_SIZE * 8 + 4)
    expect(result.stderrText).toBe('warning')
    expect(result.exitCode).toBe(7)
    expect((await execution.wait()).stdout.byteLength).toBe(0)
  })

  it('delivers accepted bytes before a late failure', async () => {
    const execution = new ShellExecution(
      async (output) => {
        await output.emit(Channel.STDOUT, enc.encode('prefix'))
        await output.emit(Channel.STDERR, enc.encode('warning'))
        throw new Error('late failure')
      },
      new LineHandle(new LineId('line'), 's', 'c'),
    )
    try {
      const first = await execution.events.next()
      const second = await execution.events.next()
      if (first.done || second.done) throw new Error('expected output events')
      expect(first.value.data).toEqual(enc.encode('prefix'))
      expect(second.value.stream).toBe('stderr')
      await expect(execution.events.next()).rejects.toThrow('late failure')
      await expect(execution.wait()).rejects.toThrow('late failure')
    } finally {
      await execution.close()
    }
  })

  it('closes before first pull and unblocks a saturated writer exactly once', async () => {
    const started = gate()
    let closed = false
    const execution = new ShellExecution(
      async (output) => {
        try {
          started.release()
          await output.emit(Channel.STDOUT, new Uint8Array(CHUNK_SIZE * 8))
          return empty()
        } finally {
          closed = true
        }
      },
      new LineHandle(new LineId('line'), 's', 'c'),
    )
    await started.promise
    await Promise.all([execution.close(), execution.close()])
    expect(closed).toBe(true)
    await expect(execution.wait()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('closes a pending output pull before joining the iterator', async () => {
    const ready = gate()
    let closed = false
    const execution = new ShellExecution(
      async (_output, signal) => {
        try {
          ready.release()
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve()
              },
              { once: true },
            )
          })
          signal.throwIfAborted()
          return empty()
        } finally {
          closed = true
        }
      },
      new LineHandle(new LineId('line'), 's', 'c'),
    )
    const pending = execution.events.next()
    await ready.promise
    await execution.close()
    await Promise.allSettled([pending])
    expect(closed).toBe(true)
  })

  it('preserves session state and channel order with public shell', async () => {
    const ws = new Workspace({})
    try {
      const session = await ws.session('sdk-test')
      const execution = await session.shell('export SDK_STREAM=yes; echo one; echo two >&2', {
        stream: true,
      })
      const events: [string, string][] = []
      for await (const event of execution.events)
        events.push([event.stream, new TextDecoder().decode(event.data)])
      expect(events).toEqual([
        ['stdout', 'one\n'],
        ['stderr', 'two\n'],
      ])
      expect((await execution.wait()).stdout.byteLength).toBe(0)
      expect((await session.shell('echo "$SDK_STREAM"')).stdoutText).toBe('yes\n')
      await execution.close()
    } finally {
      await ws.close()
    }
  })

  it('workspace close reaches a handle before first pull', async () => {
    const ws = new Workspace({})
    const execution = await ws.shell('sleep 60; echo never', { stream: true })
    await ws.close()
    await expect(execution.wait()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('a pre-cancelled handle has no effects', async () => {
    const ws = new Workspace({})
    const stop = new AbortController()
    stop.abort()
    try {
      const execution = await ws.shell('export SHOULD_NOT_EXIST=yes', {
        stream: true,
        signal: stop.signal,
      })
      await expect(execution.wait()).rejects.toMatchObject({ name: 'AbortError' })
      await execution.close()
      expect((await ws.shell('echo "$SHOULD_NOT_EXIST"')).stdoutText).toBe('\n')
    } finally {
      await ws.close()
    }
  })

  it('hangup stops a session line with SIGHUP', async () => {
    const ws = new Workspace({})
    try {
      ws.createSession('s1')
      const execution = await ws.shell('sleep 60; echo never', { sessionId: 's1', stream: true })
      let running = [...ws.processTable.live()].filter((p) => p.record.sessionId === 's1')
      for (let i = 0; i < 500 && running.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        running = [...ws.processTable.live()].filter((p) => p.record.sessionId === 's1')
      }
      expect(running.length).toBeGreaterThan(0)
      expect(await ws.hangup('s1')).toBe(1)
      await expect(execution.wait()).rejects.toMatchObject({ name: 'AbortError' })
      await execution.close()
      expect(new Set(running.map((p) => p.signal))).toEqual(new Set([1]))
    } finally {
      await ws.close()
    }
  })

  it('hangup spares a child setsid moved out of the session', async () => {
    const ws = new Workspace({})
    try {
      ws.createSession('s1')
      const line = 'setsid sleep 60 & sleep 61'
      const execution = await ws.shell(line, { sessionId: 's1', stream: true })
      const jobs = (): Map<string, ProcessHandle> =>
        new Map(
          [...ws.processTable.live()]
            .filter((p) => p.record.sessionId === 's1')
            .map((p) => [p.record.command, p]),
        )
      let found = jobs()
      for (let i = 0; i < 500 && !(found.has(line) && found.has('sleep 60')); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        found = jobs()
      }
      expect([...found.keys()].sort()).toEqual(['setsid sleep 60 & sleep 61', 'sleep 60'])
      expect(await ws.hangup('s1')).toBe(1)
      await expect(execution.wait()).rejects.toMatchObject({ name: 'AbortError' })
      await execution.close()
      expect(found.get(line)?.signal).toBe(1)
      expect(found.get('sleep 60')?.signal ?? null).toBeNull()
      expect([...ws.processTable.live()]).toContain(found.get('sleep 60'))
    } finally {
      await ws.close()
    }
  })

  it('cancel reaches a held output drain', async () => {
    const ws = new Workspace({})
    ws.policies.add(new ApproveOutput())
    const sink = new StuckSink()
    try {
      const line = ws.shell('echo held', { sink })
      const aborted = expect(line).rejects.toMatchObject({ name: 'AbortError' })
      await sink.reached
      expect(await ws.cancel()).toBe(1)
      await aborted
    } finally {
      await ws.close()
    }
  })

  it('a pipeline streams its last stage', async () => {
    const ws = new Workspace({})
    try {
      const execution = await ws.shell('{ echo ready; sleep 60; echo never; } | cat', {
        stream: true,
      })
      for await (const event of execution.events) {
        expect(event.data).toEqual(enc.encode('ready\n'))
        break
      }
      await execution.close()
    } finally {
      await ws.close()
    }
  }, 5000)

  it('breaking iteration cancels and joins the running invocation', async () => {
    const ws = new Workspace({})
    try {
      const execution = await ws.shell('echo prefix; sleep 60; echo never', { stream: true })
      for await (const event of execution.events) {
        expect(event.data).toEqual(enc.encode('prefix\n'))
        break
      }
      await expect(execution.wait()).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      await ws.close()
    }
  })
})
