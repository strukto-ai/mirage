import { Worker as NodeWorker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Worker } from '../concurrency/worker.ts'
import { concat } from '../utils/bytes.ts'
import { DiffPool, IDLE_TTL, QUEUE_LIMIT, RETIRE_BYTES } from './diff_pool.ts'
import { DiffRequest } from './diff_worker.ts'
import type { DiffOptions, InputFactory } from './diff_types.ts'

const options: DiffOptions = {
  mode: 'normal',
  context: 3,
  ignore_case: false,
  ignore_all_space: false,
  ignore_space_change: false,
  text: false,
  brief: false,
  old_label: 'a',
  new_label: 'b',
  old_header: '',
  new_header: '',
}
const empty: InputFactory = () => new Uint8Array()
const pools: DiffPool[] = []
function pool(): DiffPool {
  const result = new DiffPool()
  pools.push(result)
  return result
}
function transport() {
  return vi.spyOn(Worker.prototype, 'call').mockImplementation((_name, args) => {
    const request = DiffRequest.parse(args[0])
    if (request.kind === 'inspect')
      return Promise.resolve({
        kind: 'state',
        busy: false,
        status: 0,
        outcome: 'equal',
        stderr: new Uint8Array(),
      })
    return Promise.resolve({ kind: 'output', output: new Uint8Array() })
  })
}
function gate(): { wait: Promise<void>; release: () => void } {
  let release = (): void => undefined
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}
async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

afterEach(async () => {
  await Promise.allSettled(pools.splice(0).map((owner) => owner.close()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('diff pool ownership', () => {
  it('reuses a worker and retires it after its idle deadline', async () => {
    const calls = transport()
    const closing = vi.spyOn(Worker.prototype, 'close').mockResolvedValue()
    vi.useFakeTimers()
    const owner = pool()
    await owner.compare(options, empty, empty)
    await owner.compare(options, empty, empty)
    const opens = calls.mock.calls.flatMap(([, args], index) =>
      DiffRequest.parse(args[0]).kind === 'open' ? [calls.mock.instances[index]] : [],
    )
    expect(opens).toHaveLength(2)
    expect(opens[0]).toBe(opens[1])
    expect(closing).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(IDLE_TTL)
    expect(closing).toHaveBeenCalledOnce()
    await owner.compare(options, empty, empty)
    expect(calls.mock.instances.at(-1)).not.toBe(opens[0])
  })

  it('admits FIFO before reading and bounds its waiting queue', async () => {
    transport()
    const owner = pool()
    const held = gate()
    const admitted: number[] = []
    const blocked = async (): Promise<Uint8Array> => {
      await held.wait
      return new Uint8Array()
    }
    const first = owner.compare(options, blocked, empty)
    const second = owner.compare(options, blocked, empty)
    await tick()
    const queued = Array.from({ length: QUEUE_LIMIT }, (_, index) =>
      owner.compare(
        options,
        () => {
          admitted.push(index)
          return new Uint8Array()
        },
        empty,
      ),
    )
    await expect(owner.compare(options, empty, empty)).rejects.toThrow('queue is full')
    expect(admitted).toEqual([])
    held.release()
    await Promise.all([first, second, ...queued])
    expect(admitted).toEqual(Array.from({ length: QUEUE_LIMIT }, (_, index) => index))
  })

  it('cancels queued work without reading and closes active work', async () => {
    transport()
    const closing = vi.spyOn(Worker.prototype, 'close').mockResolvedValue()
    const owner = pool()
    const held = gate()
    const blocked = async (): Promise<Uint8Array> => {
      await held.wait
      return new Uint8Array()
    }
    const a = owner.compare(options, blocked, empty)
    const b = owner.compare(options, blocked, empty)
    await tick()
    const source = vi.fn(empty)
    const abort = new AbortController()
    const waiting = owner.compare(options, source, source, abort.signal)
    const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await rejected
    expect(source).not.toHaveBeenCalled()
    const settled = Promise.allSettled([a, b])
    await owner.close()
    expect((await settled).every((item) => item.status === 'rejected')).toBe(true)
    expect(closing).toHaveBeenCalledTimes(2)
    held.release()
    await expect(owner.compare(options, empty, empty)).rejects.toThrow('closed')
  })

  it('retires malformed replies and recovers without reading the failed pair', async () => {
    const calls = transport()
    const owner = pool()
    const source = vi.fn(empty)
    calls.mockResolvedValueOnce({ kind: 'broken' })
    await expect(owner.compare(options, source, source)).rejects.toThrow()
    expect(source).not.toHaveBeenCalled()
    await expect(owner.compare(options, empty, empty)).resolves.toMatchObject({ status: 0 })
  })

  it('retains failed termination capacity and reports the failure after retry', async () => {
    const calls = transport()
    calls.mockRejectedValue(new Error('worker failed'))
    const closing = vi.spyOn(Worker.prototype, 'close').mockRejectedValue(new Error('stop failed'))
    const owner = pool()
    await expect(owner.compare(options, empty, empty)).rejects.toThrow('stop failed')
    await expect(owner.compare(options, empty, empty)).rejects.toThrow('stop failed')
    await expect(owner.compare(options, empty, empty)).rejects.toThrow('capacity is unavailable')
    expect(closing).toHaveBeenCalledTimes(2)
    closing.mockResolvedValue()
    await expect(owner.close()).rejects.toThrow('cleanup failed')
    expect(closing).toHaveBeenCalledTimes(4)
    await expect(owner.close()).rejects.toThrow('cleanup failed')
    expect(closing).toHaveBeenCalledTimes(4)
  })

  it('retains output chunks and retires high-volume workers', async () => {
    transport()
    const closing = vi.spyOn(Worker.prototype, 'close').mockResolvedValue()
    const owner = pool()
    const bytes = new Uint8Array(RETIRE_BYTES + 1)
    const result = await owner.compare(options, () => bytes, empty)
    expect(result.output).toEqual([])
    expect(closing).toHaveBeenCalledOnce()
  })

  it('waits for every worker when one close fails', async () => {
    transport()
    const held = gate()
    const owner = pool()
    const input = async (): Promise<Uint8Array> => {
      await held.wait
      return new Uint8Array()
    }
    const active = Promise.allSettled([
      owner.compare(options, input, empty),
      owner.compare(options, input, empty),
    ])
    await tick()
    const stopped = gate()
    const closing = vi
      .spyOn(Worker.prototype, 'close')
      .mockRejectedValueOnce(new Error('stop failed'))
      .mockImplementationOnce(async () => stopped.wait)
    const finished = vi.fn()
    const close = owner.close()
    void close.then(finished, finished)
    await tick()
    expect(closing).toHaveBeenCalledTimes(2)
    expect(finished).not.toHaveBeenCalled()
    stopped.release()
    await expect(close).rejects.toThrow('cleanup failed')
    await active
    held.release()
  })
})

describe('diff pool with its Rust worker', () => {
  it('preserves original bytes, statuses and bounded output', async () => {
    const owner = pool()
    const old = new Uint8Array([0xff, 10, 65, 13, 10])
    const next = new Uint8Array([0xfe, 10, 66, 13, 10])
    const result = await owner.compare(
      options,
      () => old,
      () => next,
    )
    expect(result.status).toBe(1)
    expect(result.outcome).toBe('different')
    expect(concat(result.output)).toEqual(
      new Uint8Array([
        ...new TextEncoder().encode('1,2c1,2\n< '),
        0xff,
        10,
        ...new TextEncoder().encode('< A\r\n---\n> '),
        0xfe,
        10,
        ...new TextEncoder().encode('> B\r\n'),
      ]),
    )
    const normalized = await owner.compare(
      { ...options, ignore_case: true },
      () => new TextEncoder().encode('A\n'),
      () => new TextEncoder().encode('a\n'),
    )
    expect(normalized).toMatchObject({ status: 0, outcome: 'equal', output: [] })
    const huge = new Uint8Array(200_000).fill(65)
    const large = await owner.compare({ ...options, text: true }, () => huge, empty)
    expect(large.output.length).toBeGreaterThan(1)
    expect(large.output.every((chunk) => chunk.byteLength <= 64 * 1024)).toBe(true)
    expect(concat(large.output).byteLength).toBeGreaterThan(huge.byteLength)
  })

  it('cancels synchronous matching while host timers keep running and recovers', async () => {
    const owner = pool()
    await owner.compare(options, empty, empty)
    const old = new TextEncoder().encode(
      Array.from({ length: 100_000 }, (_, i) => `old-${String(i)}\n`).join(''),
    )
    const next = new TextEncoder().encode(
      Array.from({ length: 100_000 }, (_, i) => `new-${String(i)}\n`).join(''),
    )
    const abort = new AbortController()
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 1)
    let cancel: ReturnType<typeof setTimeout> | undefined
    const original: unknown = Object.getOwnPropertyDescriptor(Worker.prototype, 'call')?.value
    if (typeof original !== 'function') throw new Error('worker call is unavailable')
    vi.spyOn(Worker.prototype, 'call').mockImplementation(function (
      this: Worker,
      name,
      args,
      signal,
    ) {
      const request = DiffRequest.parse(args[0])
      if (request.kind === 'end' && request.index === 1)
        cancel = setTimeout(() => {
          abort.abort()
        }, 1)
      const result: unknown = Reflect.apply(original, this, [name, args, signal])
      return Promise.resolve(result)
    })
    try {
      await expect(
        owner
          .compare(
            options,
            () => old,
            () => next,
            abort.signal,
          )
          .then((result) => result.status),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(ticks).toBeGreaterThan(0)
      await expect(owner.compare(options, empty, empty)).resolves.toMatchObject({ status: 0 })
    } finally {
      clearInterval(timer)
      clearTimeout(cancel)
    }
  }, 10_000)
})

it('retains a live worker after real termination is refused and joins it at owner close', async () => {
  const owner = pool()
  await owner.compare(options, empty, empty)
  const termination = vi
    .spyOn(NodeWorker.prototype, 'terminate')
    .mockRejectedValueOnce(new Error('termination refused before stop'))
  await new Promise<void>((resolve) => setTimeout(resolve, IDLE_TTL + 50))
  expect(termination).toHaveBeenCalledOnce()
  await expect(owner.compare(options, empty, empty)).resolves.toMatchObject({ status: 0 })
  await expect(owner.close()).rejects.toThrow('cleanup failed')
  expect(termination).toHaveBeenCalledTimes(3)
  expect(
    termination.mock.settledResults.slice(1).every((result) => result.type === 'fulfilled'),
  ).toBe(true)
})

it('retries a first termination failure during owner close and retains its cleanup error', async () => {
  const owner = pool()
  await owner.compare(options, empty, empty)
  const termination = vi
    .spyOn(NodeWorker.prototype, 'terminate')
    .mockRejectedValueOnce(new Error('first owner stop refused before termination'))
  await expect(owner.close()).rejects.toThrow('cleanup failed')
  expect(termination).toHaveBeenCalledTimes(2)
  expect(termination.mock.settledResults.map((result) => result.type)).toEqual([
    'rejected',
    'fulfilled',
  ])
  await expect(owner.close()).rejects.toThrow('cleanup failed')
  expect(termination).toHaveBeenCalledTimes(2)
})
