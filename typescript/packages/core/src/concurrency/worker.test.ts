import { Worker as NodeWorker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { Worker } from './worker.ts'

describe('computation worker', () => {
  it('serializes calls and recovers after a computation fails', async () => {
    const worker = new Worker()
    try {
      expect(
        await Promise.all([
          worker.call('scan', ['a', '', false, 'abc']),
          worker.call('scan', ['b', '', false, 'abc']),
        ]),
      ).toMatchObject([[{ values: ['a'], index: 0 }], [{ values: ['b'], index: 1 }]])
      await expect(worker.call('scan', ['[', '', false, 'abc'])).rejects.toThrow()
      expect(await worker.call('scan', ['c', '', false, 'abc'])).toMatchObject([
        { values: ['c'], index: 2 },
      ])
    } finally {
      await worker.close()
    }
  })

  it('terminates and joins a worker blocked in synchronous computation', async () => {
    const termination = vi.spyOn(NodeWorker.prototype, 'terminate')
    const worker = new Worker()
    const controller = new AbortController()
    try {
      await worker.call('scan', ['a', '', false, 'a'])
      const task = worker.call(
        'scan',
        ['^(a+)+$', '', false, 'a'.repeat(80) + '!'],
        controller.signal,
      )
      const refused = expect(task).rejects.toMatchObject({ name: 'AbortError' })
      await new Promise((resolve) => setTimeout(resolve, 30))
      controller.abort()
      await refused
      expect(termination).toHaveBeenCalledOnce()
      expect(termination.mock.settledResults[0]?.type).toBe('fulfilled')
    } finally {
      controller.abort()
      await worker.close()
      termination.mockRestore()
    }
  }, 5000)
})

it('retains a worker handle until a rejected termination succeeds on retry', async () => {
  const worker = new Worker()
  const termination = vi
    .spyOn(NodeWorker.prototype, 'terminate')
    .mockRejectedValueOnce(new Error('termination refused'))
  try {
    await worker.call('scan', ['a', '', false, 'a'])
    const first = worker.close()
    expect(worker.close()).toBe(first)
    await expect(first).rejects.toThrow('termination refused')
    expect(worker.close()).toBe(first)
    await worker.close(true)
    expect(termination).toHaveBeenCalledTimes(2)
  } finally {
    termination.mockRestore()
    await worker.close()
  }
})

it('makes an unexpected idle exit terminal instead of leaving a later call pending', async () => {
  const worker = new Worker()
  const posting = vi.spyOn(NodeWorker.prototype, 'postMessage')
  try {
    await worker.call('scan', ['a', '', false, 'a'])
    const handle = posting.mock.instances[0]
    if (!(handle instanceof NodeWorker)) throw new Error('worker handle was not recorded')
    await handle.terminate()
    await expect(worker.call('scan', ['a', '', false, 'a'])).rejects.toThrow('exited')
  } finally {
    posting.mockRestore()
    await worker.close()
  }
})

it('joins a worker cancelled during startup', async () => {
  const worker = new Worker()
  const abort = new AbortController()
  const termination = vi.spyOn(NodeWorker.prototype, 'terminate')
  try {
    const call = worker.call('scan', ['a', '', false, 'a'], abort.signal)
    const rejected = expect(call).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await rejected
    expect(termination).toHaveBeenCalledOnce()
    expect(termination.mock.settledResults[0]?.type).toBe('fulfilled')
  } finally {
    await worker.close()
    termination.mockRestore()
  }
})

it('cleans up synchronous transport failures and permits recovery', async () => {
  const worker = new Worker()
  const posting = vi.spyOn(NodeWorker.prototype, 'postMessage').mockImplementationOnce(() => {
    throw new Error('cannot post computation')
  })
  try {
    await expect(worker.call('scan', ['a', '', false, 'a'])).rejects.toThrow('cannot post')
    await expect(worker.call('scan', ['a', '', false, 'a'])).resolves.toHaveLength(1)
  } finally {
    await worker.close()
    posting.mockRestore()
  }
})
