import { describe, expect, it, vi } from 'vitest'
import { ShellExecution } from '@struktoai/mirage-core/workspace/shell_execution'
import { ExecutionScope } from '@struktoai/mirage-core/workspace/execution'
import { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/types'
import { INTERVAL, LIMIT, OutputProgress, collectExecution } from './progress.ts'

describe('output progress', () => {
  it('joins the producer after a trailing preview delivery fails', async () => {
    let closed = false
    const execution = new ShellExecution(async (output, signal) => {
      try {
        await output.emit('stdout', new TextEncoder().encode('first'))
        await output.emit('stdout', new TextEncoder().encode('second'))
        await new Promise<void>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('aborted', 'AbortError'))
            },
            { once: true },
          )
        })
        return new ExecuteResult(new Uint8Array(), new Uint8Array(), 0)
      } finally {
        closed = true
      }
    }, new ExecutionScope())
    const progress = new OutputProgress((value, message) => {
      if (value === 2) return Promise.reject(new Error('closed transport'))
      expect(message).toBe('[stdout] first')
      return Promise.resolve()
    })
    await expect(collectExecution(execution, progress)).rejects.toThrow('closed transport')
    expect(closed).toBe(true)
    await expect(execution.wait()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('decodes channels incrementally and bounds coalesced bursts', async () => {
    const messages: [number, string][] = []
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now * 1000)
    try {
      const progress = new OutputProgress((value, message) => {
        messages.push([value, message])
        return Promise.resolve()
      })
      await progress.feed('stdout', new Uint8Array([0xe2]))
      await progress.feed('stderr', new Uint8Array([0xf0, 0x9f]))
      expect(messages).toEqual([])
      await progress.feed('stdout', new Uint8Array([0x82, 0xac]))
      expect(messages).toEqual([[1, '[stdout] €']])
      await progress.feed('stdout', new TextEncoder().encode('a'.repeat(LIMIT * 10)))
      await progress.feed('stderr', new Uint8Array([0x99, 0x82]))
      expect(messages).toHaveLength(1)
      now += INTERVAL
      await progress.feed('stdout', new TextEncoder().encode('z'))
      expect(messages[1]?.[0]).toBe(2)
      expect(messages[1]?.[1].startsWith('[stdout] …')).toBe(true)
      expect(messages[1]?.[1].length).toBeLessThanOrEqual(LIMIT + '[stdout] '.length)
      expect(messages[2]).toEqual([3, '[stderr] 🙂'])
      await progress.feed('stderr', new Uint8Array([0xe2]))
      await progress.finish()
      expect(messages.at(-1)).toEqual([4, '[stderr] �'])
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('flushes the trailing preview while the producer is silent', async () => {
    const messages: [number, string][] = []
    let delivered!: () => void
    const ready = new Promise<void>((resolve) => {
      delivered = resolve
    })
    const progress = new OutputProgress((value, message) => {
      messages.push([value, message])
      if (value === 2) delivered()
      return Promise.resolve()
    })
    try {
      await progress.feed('stdout', new TextEncoder().encode('first'))
      await progress.feed('stdout', new TextEncoder().encode('second'))
      expect(messages).toHaveLength(1)
      await ready
      expect(messages).toEqual([
        [1, '[stdout] first'],
        [2, '[stdout] second'],
      ])
    } finally {
      await progress.close()
    }
  })

  it('cancels execution and observes a trailing delivery failure', async () => {
    let cancel!: () => void
    const canceled = new Promise<void>((resolve) => {
      cancel = resolve
    })
    const progress = new OutputProgress((value, message) => {
      if (value === 2) return Promise.reject(new Error('closed transport'))
      expect(message).toBe('[stdout] first')
      return Promise.resolve()
    })
    progress.bind(cancel)
    await progress.feed('stdout', new TextEncoder().encode('first'))
    await progress.feed('stdout', new TextEncoder().encode('second'))
    await canceled
    await expect(progress.close()).rejects.toThrow('closed transport')
  })
})
