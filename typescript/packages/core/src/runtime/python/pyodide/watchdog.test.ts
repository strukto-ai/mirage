import { afterEach, describe, expect, it, vi } from 'vitest'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { getTestParser } from '../../../../tests/workspace/fixtures/workspace_fixture.ts'
import { context } from '../../../../tests/workspace/fixtures/context.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { PyodideRuntime } from './runtime.ts'
import { WATCH_INTERVAL_MS, watchMemory } from './watchdog.ts'

const DEC = new TextDecoder()

describe('watchMemory', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls exceeded once, when a read passes the limit', async () => {
    vi.useFakeTimers()
    const reads = [10, 20, 200, 300]
    const exceeded = vi.fn()
    const stop = watchMemory(() => Promise.resolve(reads.shift() ?? 400), 100, exceeded)
    for (let tick = 0; tick < 6; tick++) await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS)
    expect(exceeded).toHaveBeenCalledTimes(1)
    expect(exceeded).toHaveBeenCalledWith(200)
    stop()
  })

  it('reads nothing once stopped', async () => {
    vi.useFakeTimers()
    const memory = vi.fn(() => Promise.resolve(10))
    const stop = watchMemory(memory, 100, () => undefined)
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS)
    stop()
    const seen = memory.mock.calls.length
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS * 4)
    expect(memory.mock.calls.length).toBe(seen)
  })
})

describe('pyodide maxMemory', { timeout: 120_000 }, () => {
  it('stops a run that passes the cap and starts the next on a fresh worker', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        shellParser: await getTestParser(),
        runtimes: [new PyodideRuntime({ config: { maxMemory: '128M' } }), 'workspace'],
      },
    )
    try {
      const big = await ws.shell(
        'python3 -c "import time; x = bytearray(512 * 1024 * 1024); time.sleep(5)"',
      )
      expect(big.exitCode).toBe(1)
      expect(DEC.decode(big.stderr)).toContain('MemoryError: the run passed max_memory (128M)')
      const small = await ws.shell('python3 -c "print(1 + 1)"')
      expect([small.exitCode, DEC.decode(small.stdout)]).toEqual([0, '2\n'])
    } finally {
      await ws.close()
    }
  })

  it('fails a run that passed the cap between two reads', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        shellParser: await getTestParser(),
        runtimes: [new PyodideRuntime({ config: { maxMemory: '128M' } }), 'workspace'],
      },
    )
    try {
      const fast = await ws.shell('python3 -c "x = bytearray(512 * 1024 * 1024)"')
      expect(fast.exitCode).toBe(1)
      expect(DEC.decode(fast.stderr)).toContain('MemoryError: the run passed max_memory (128M)')
    } finally {
      await ws.close()
    }
  })

  it('caps a run outside a workspace too', async () => {
    const rt = new PyodideRuntime({ config: { maxMemory: 64 * 1024 * 1024 } })
    try {
      const run = (code: string) =>
        rt.interpret(undefined, { code, args: [], stdin: null }, context())
      const big = await run('x = bytearray(200 * 1024 * 1024)')
      expect(big.exitCode).toBe(1)
      expect(DEC.decode(big.stderr ?? new Uint8Array())).toContain(
        `MemoryError: the run passed max_memory (${String(64 * 1024 * 1024)})`,
      )
      const small = await run('print(1 + 1)')
      expect([small.exitCode, DEC.decode(small.stdout)]).toEqual([0, '2\n'])
    } finally {
      await rt.close()
    }
  })

  it('refuses a cap that is not a size', () => {
    for (const bad of ['lots', '1.5G', '-5M', -1, 1.5]) {
      expect(() => new PyodideRuntime({ config: { maxMemory: bad } }), String(bad)).toThrow(
        /max_memory must be a size/,
      )
    }
  })
})
