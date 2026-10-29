import { Worker as NodeWorker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { Worker } from './worker.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const OPEN = {
  kind: 'open',
  options: {
    mode: 'normal',
    context: 3,
    ignore_case: false,
    ignore_all_space: false,
    ignore_space_change: false,
    text: false,
    brief: false,
    old_label: 'a',
    new_label: 'b',
    old_header: 'a',
    new_header: 'b',
  },
}
const CLOSE = { kind: 'close' }

function lines(prefix: string, count: number): Uint8Array {
  return ENC.encode(Array.from({ length: count }, (_, i) => `${prefix}${String(i)}\n`).join(''))
}

describe('computation worker', () => {
  it('serializes calls and recovers after a computation fails', async () => {
    const worker = new Worker()
    try {
      const replies = await Promise.all([
        worker.call('diffDispatch', [OPEN]),
        worker.call('diffDispatch', [{ kind: 'feed', index: 0, chunk: ENC.encode('a\n') }]),
        worker.call('diffDispatch', [{ kind: 'feed', index: 1, chunk: ENC.encode('b\n') }]),
        worker.call('diffDispatch', [{ kind: 'end', index: 0 }]),
        worker.call('diffDispatch', [{ kind: 'end', index: 1 }]),
        worker.call<{ output: Uint8Array }>('diffDispatch', [{ kind: 'drain' }]),
      ])
      expect(DEC.decode(replies[5].output)).toBe('1c1\n< a\n---\n> b\n')
      await expect(worker.call('nothing', [])).rejects.toThrow('No computation named nothing')
      expect(await worker.call('diffDispatch', [CLOSE])).toMatchObject({ kind: 'output' })
    } finally {
      await worker.close()
    }
  })

  it('terminates and joins a worker blocked in synchronous computation', async () => {
    const termination = vi.spyOn(NodeWorker.prototype, 'terminate')
    const worker = new Worker()
    const controller = new AbortController()
    try {
      await worker.call('diffDispatch', [OPEN])
      await worker.call('diffDispatch', [{ kind: 'feed', index: 0, chunk: lines('a', 1_000_000) }])
      await worker.call('diffDispatch', [{ kind: 'feed', index: 1, chunk: lines('b', 1_000_000) }])
      await worker.call('diffDispatch', [{ kind: 'end', index: 0 }])
      const task = worker.call('diffDispatch', [{ kind: 'end', index: 1 }], controller.signal)
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
    await worker.call('diffDispatch', [CLOSE])
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
    await worker.call('diffDispatch', [CLOSE])
    const handle = posting.mock.instances[0]
    if (!(handle instanceof NodeWorker)) throw new Error('worker handle was not recorded')
    await handle.terminate()
    await expect(worker.call('diffDispatch', [CLOSE])).rejects.toThrow('exited')
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
    const call = worker.call('diffDispatch', [CLOSE], abort.signal)
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
    await expect(worker.call('diffDispatch', [CLOSE])).rejects.toThrow('cannot post')
    await expect(worker.call('diffDispatch', [CLOSE])).resolves.toMatchObject({ kind: 'output' })
  } finally {
    await worker.close()
    posting.mockRestore()
  }
})
