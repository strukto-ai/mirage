import { expect, it, vi } from 'vitest'
import { RAMExecutionStore } from './ram.ts'
import { ExecutionStatus, type ExecutionRecord } from './types.ts'

function record(id: string, workspaceId = 'workspace'): ExecutionRecord {
  return {
    id,
    workspaceId,
    sessionId: 'session',
    command: 'echo hi',
    status: ExecutionStatus.PENDING,
    revision: 0,
    cancelRequested: false,
    submittedAt: Date.now() / 1000,
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  }
}

it('isolates snapshots, observes revision changes and preserves terminal records', async () => {
  const store = new RAMExecutionStore()
  const first = record('one')
  expect(await store.create(first)).toBe(true)
  expect(await store.create(first)).toBe(false)
  const waiting = store.waitForChange(first.id, 0)
  const running = { ...first, revision: 1, status: ExecutionStatus.RUNNING }
  expect(await store.compareAndSet(running, 0)).toBe(true)
  expect(await store.compareAndSet(running, 0)).toBe(false)
  expect(await waiting).toEqual(running)
  expect(await store.waitForChange(first.id, 0)).toEqual(running)
  expect(await store.waitForChange(first.id, 1, 0.001)).toEqual(running)
  const stop = new AbortController()
  const stopped = store.waitForChange(first.id, 1, undefined, stop.signal)
  stop.abort()
  expect(await stopped).toEqual(running)
  const finished = {
    ...running,
    revision: 2,
    status: ExecutionStatus.DONE,
    finishedAt: Date.now() / 1000,
    result: { stdout: ['hi'] },
  }
  expect(await store.compareAndSet(finished, 1)).toBe(true)
  const read = await store.get(first.id)
  if (read === null) throw new Error('record missing')
  expect(JSON.parse(JSON.stringify(read))).toEqual(finished)
  ;(read.result as { stdout: string[] }).stdout.push('mutation')
  expect((await store.get(first.id))?.result).toEqual({ stdout: ['hi'] })
  expect(await store.list()).toEqual([{ ...finished, result: null }])
  expect(
    await store.compareAndSet({ ...finished, revision: 3, status: ExecutionStatus.RUNNING }, 2),
  ).toBe(false)
})

it('expires completed records while retaining active records and workspace scope', async () => {
  const store = new RAMExecutionStore(2, 10)
  const active = record('active', 'other')
  await store.create(active)
  const now = Date.now()
  for (let i = 0; i < 3; i++) {
    const r = record(String(i))
    await store.create(r)
    await store.compareAndSet(
      { ...r, revision: 1, status: ExecutionStatus.DONE, finishedAt: now / 1000 },
      0,
    )
  }
  expect(await store.get('0')).toBeNull()
  expect(await store.list('workspace')).toHaveLength(2)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 11_000)
  try {
    expect(await store.list()).toEqual([active])
  } finally {
    clock.mockRestore()
  }
  const waiting = store.waitForChange(active.id, 0)
  const stopped = expect(waiting).rejects.toThrow('closed')
  await store.close()
  await stopped
})

it('retains terminal creates by completion time even when inserted out of order', async () => {
  const store = new RAMExecutionStore(2, 10)
  const active = record('active')
  await store.create(active)
  const now = Date.now()
  for (const [id, finishedAt] of [
    ['newest', now / 1000 + 2],
    ['oldest', now / 1000],
    ['middle', now / 1000 + 1],
  ] as const) {
    await store.create({ ...active, id, status: ExecutionStatus.DONE, finishedAt })
  }
  expect(await store.get('oldest')).toBeNull()
  expect((await store.list()).map((entry) => entry.id).sort()).toEqual([
    'active',
    'middle',
    'newest',
  ])
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 11_500)
  try {
    expect((await store.list()).map((entry) => entry.id).sort()).toEqual(['active', 'newest'])
    await store.create({
      ...active,
      id: 'expired',
      status: ExecutionStatus.DONE,
      finishedAt: now / 1000,
    })
    expect(await store.get('expired')).toBeNull()
  } finally {
    clock.mockRestore()
  }
})
