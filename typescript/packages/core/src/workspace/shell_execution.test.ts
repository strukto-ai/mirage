import { describe, expect, it } from 'vitest'
import { CHUNK_SIZE } from '../io/cooperative.ts'
import { Channel } from '../shell/console/types.ts'
import { ExecutionScope } from './execution.ts'
import { ShellExecution } from './shell_execution.ts'
import { ExecuteResult } from './workspace/types.ts'
import { Workspace } from './workspace/workspace.ts'
import { getTestParser } from './fixtures/workspace_fixture.ts'

const enc = new TextEncoder()
const empty = (): ExecuteResult => new ExecuteResult(new Uint8Array(), new Uint8Array(), 0)

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('ShellExecution', () => {
  it('awaits the event observer while collecting exact output', async () => {
    const entered = gate(),
      release = gate()
    let finished = false
    const seen: string[] = []
    const execution = new ShellExecution(async (output) => {
      await output.emit(Channel.STDOUT, new Uint8Array(CHUNK_SIZE * 8).fill(97))
      await output.emit(Channel.STDERR, enc.encode('warning'))
      finished = true
      return new ExecuteResult(new Uint8Array(), new Uint8Array(), 7)
    }, new ExecutionScope())
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
    const execution = new ShellExecution(async (output, signal) => {
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
    }, new ExecutionScope())
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
    const execution = new ShellExecution(async (output) => {
      started.release()
      await output.emit(Channel.STDOUT, new Uint8Array(CHUNK_SIZE * 8).fill(97))
      await output.emit(Channel.STDERR, enc.encode('warning'))
      await output.emit(Channel.STDOUT, enc.encode('tail'))
      finished = true
      return new ExecuteResult(new Uint8Array(), new Uint8Array(), 7)
    }, new ExecutionScope())
    await started.promise
    expect(finished).toBe(false)
    const result = await execution.collect()
    expect(result.stdout.byteLength).toBe(CHUNK_SIZE * 8 + 4)
    expect(result.stderrText).toBe('warning')
    expect(result.exitCode).toBe(7)
    expect((await execution.wait()).stdout.byteLength).toBe(0)
  })

  it('delivers accepted bytes before a late failure', async () => {
    const execution = new ShellExecution(async (output) => {
      await output.emit(Channel.STDOUT, enc.encode('prefix'))
      await output.emit(Channel.STDERR, enc.encode('warning'))
      throw new Error('late failure')
    }, new ExecutionScope())
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
    const execution = new ShellExecution(async (output) => {
      try {
        started.release()
        await output.emit(Channel.STDOUT, new Uint8Array(CHUNK_SIZE * 8))
        return empty()
      } finally {
        closed = true
      }
    }, new ExecutionScope())
    await started.promise
    await Promise.all([execution.close(), execution.close()])
    expect(closed).toBe(true)
    await expect(execution.wait()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('closes a pending output pull before joining the iterator', async () => {
    const ready = gate()
    let closed = false
    const execution = new ShellExecution(async (_output, signal) => {
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
    }, new ExecutionScope())
    const pending = execution.events.next()
    await ready.promise
    await execution.close()
    await Promise.allSettled([pending])
    expect(closed).toBe(true)
  })

  it('preserves session state and channel order with public shell', async () => {
    const ws = new Workspace({}, { shellParser: await getTestParser() })
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
    const ws = new Workspace({}, { shellParser: await getTestParser() })
    const execution = await ws.shell('sleep 60; echo never', { stream: true })
    await ws.close()
    await expect(execution.wait()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('a pre-cancelled handle has no effects', async () => {
    const ws = new Workspace({}, { shellParser: await getTestParser() })
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

  it('breaking iteration cancels and joins the running invocation', async () => {
    const ws = new Workspace({}, { shellParser: await getTestParser() })
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
