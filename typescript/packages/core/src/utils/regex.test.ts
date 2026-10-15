import { expect, it, vi } from 'vitest'
import { Worker } from '../concurrency/worker.ts'
import { AsyncRegex } from './regex.ts'

it('sends buffered subjects ahead and keeps the invocation worker between files', async () => {
  const worker = new Worker()
  const calls = vi.spyOn(worker, 'call')
  const close = vi.spyOn(worker, 'close')
  try {
    for (let i = 0; i < 2; i++) {
      const pattern = new AsyncRegex(/(x+)+/, undefined, true, worker)
      await pattern.prepare('x', () => ['xx', 'no match'])
      await pattern.prepare('xx')
      expect(pattern.matches('xx')).toHaveLength(1)
      await pattern.prepare('no match')
      expect(pattern.search('no match')).toBeNull()
      await pattern.close()
    }
    expect(calls).toHaveBeenCalledTimes(6)
    expect(close).not.toHaveBeenCalled()
  } finally {
    await worker.close()
  }
})

it('answers a subject before a slow one sent behind it', async () => {
  const pattern = new AsyncRegex(/ok|(a|b)*(a|b)*$/)
  try {
    await pattern.prepare('ok', () => ['a'.repeat(10_000) + '!'])
    expect(pattern.search('ok')).not.toBeNull()
  } finally {
    await pattern.close()
  }
}, 5000)

it('never hands answers left unread to the next pattern', async () => {
  const worker = new Worker()
  try {
    const first = new AsyncRegex(/(x+)+/, undefined, true, worker)
    await first.prepare('x', () => ['xx', 'xxx'])
    await first.close()
    const second = new AsyncRegex(/(y+)+/, undefined, true, worker)
    await second.prepare('y')
    expect(second.matches('y')).toHaveLength(1)
    await second.close()
  } finally {
    await worker.close()
  }
})

it('searches a bounded subject in place', async () => {
  const worker = new Worker()
  const calls = vi.spyOn(worker, 'call')
  const pattern = new AsyncRegex(/x/, undefined, true, worker)
  try {
    await pattern.prepare('x', () => ['xx', 'no match'])
    await pattern.prepare('xx')
    expect(pattern.matches('xx')).toHaveLength(2)
    await pattern.prepare('no match')
    expect(pattern.search('no match')).toBeNull()
    expect(calls).not.toHaveBeenCalled()
  } finally {
    await pattern.close()
    await worker.close()
  }
})

it('starts the worker only for a subject past the limit', async () => {
  const worker = new Worker()
  const calls = vi.spyOn(worker, 'call')
  const pattern = new AsyncRegex(/x.*y/, undefined, true, worker)
  const long = 'x'.repeat(1000) + 'y'
  try {
    await pattern.prepare('x y')
    expect(calls).not.toHaveBeenCalled()
    await pattern.prepare(long)
    expect(calls).toHaveBeenCalledTimes(1)
    expect(pattern.search(long)?.[0]).toBe(long)
  } finally {
    await pattern.close()
    await worker.close()
  }
})
