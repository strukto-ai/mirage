import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from 'redis'
import { ExecutionStatus, type ExecutionRecord } from '@struktoai/mirage-core/execution/types'
import { RedisExecutionStore } from './store.ts'

const REDIS_URL = process.env.REDIS_URL ?? ''

function record(id: string, workspaceId = 'workspace'): ExecutionRecord {
  return {
    id,
    workspaceId,
    sessionId: 'session',
    command: 'echo hé',
    submittedAt: Date.now() / 1000,
    status: ExecutionStatus.PENDING,
    revision: 0,
    cancelRequested: false,
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  }
}

describe.skipIf(REDIS_URL === '')('RedisExecutionStore', () => {
  const opened: RedisExecutionStore[] = []
  const prefixes = new Set<string>()

  function makeStore(
    prefix = `test:execution:{${randomUUID()}}:`,
    maxCompleted = 1024,
    retentionSeconds = 3600,
  ) {
    const store = new RedisExecutionStore(REDIS_URL, prefix, maxCompleted, retentionSeconds)
    opened.push(store)
    prefixes.add(prefix)
    return store
  }

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const store of opened.splice(0)) await store.close()
    const client = createClient({ url: REDIS_URL })
    await client.connect()
    try {
      for (const prefix of prefixes) await client.del([`${prefix}records`, `${prefix}completed`])
      prefixes.clear()
    } finally {
      await client.quit()
    }
  })

  it('atomically creates and compares revisions across independent clients', async () => {
    const first = makeStore()
    const second = makeStore(first.keyPrefix)
    const initial = record('one')
    expect((await Promise.all([first.create(initial), second.create(initial)])).sort()).toEqual([
      false,
      true,
    ])
    const canceled = { ...initial, revision: 1, cancelRequested: true }
    const running = { ...initial, revision: 1, status: ExecutionStatus.RUNNING }
    const outcomes = await Promise.all([
      first.compareAndSet(canceled, 0),
      second.compareAndSet(running, 0),
    ])
    expect([...outcomes].sort()).toEqual([false, true])
    const winner = outcomes[0] ? canceled : running
    expect(await first.get(initial.id)).toEqual(winner)
    expect(await second.get(initial.id)).toEqual(winner)
    expect(await first.compareAndSet({ ...winner, revision: 8 }, 0)).toBe(false)
    await expect(first.compareAndSet({ ...winner, revision: 8 }, 1)).rejects.toThrow(
      'increment the revision',
    )
    await expect(
      first.compareAndSet({ ...winner, revision: 2, sessionId: 'other' }, 1),
    ).rejects.toThrow('identity cannot change')
    const cancellation = { ...winner, revision: 2, cancelRequested: true }
    expect(await second.compareAndSet(cancellation, 1)).toBe(true)
    await expect(
      first.compareAndSet({ ...cancellation, revision: 3, cancelRequested: false }, 2),
    ).rejects.toThrow('cancellation intent')
  })

  it('observes remote revisions before and after waiting, with timeout and cancellation', async () => {
    const first = makeStore()
    const second = makeStore(first.keyPrefix)
    const initial = record('one')
    await first.create(initial)
    let settled = false
    const waiting = second.waitForChange(initial.id, 0).then((value) => {
      settled = true
      return value
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    const running = { ...initial, revision: 1, status: ExecutionStatus.RUNNING }
    await first.compareAndSet(running, 0)
    expect(await waiting).toEqual(running)
    expect(await second.waitForChange(initial.id, 0)).toEqual(running)
    expect(await second.waitForChange(initial.id, 1, 0.001)).toEqual(running)
    const stop = new AbortController()
    const canceled = second.waitForChange(initial.id, 1, undefined, stop.signal)
    stop.abort()
    expect(await canceled).toEqual(running)
    expect(await second.waitForChange('missing', 0)).toBeNull()
  })

  it('pins terminal snapshots and the shared Python wire schema without modifying JSON results', async () => {
    const first = makeStore()
    const second = makeStore(first.keyPrefix)
    const initial = record('one')
    await first.create(initial)
    const finished = {
      ...initial,
      revision: 1,
      status: ExecutionStatus.DONE,
      finishedAt: Date.now() / 1000,
      result: { empty: [], nested: {}, stdout: ['hé'] },
    }
    expect(await second.compareAndSet(finished, 0)).toBe(true)
    expect(await first.compareAndSet({ ...finished, revision: 2 }, 1)).toBe(false)
    const snapshot = await first.get(initial.id)
    ;(snapshot?.result as { stdout: string[] }).stdout.push('mutation')
    expect(await second.get(initial.id)).toEqual(finished)
    expect(await first.list('workspace')).toEqual([{ ...finished, result: null }])
    expect(await first.list('other')).toEqual([])
    const client = createClient({ url: REDIS_URL })
    await client.connect()
    try {
      const raw = await client.hGet(`${first.keyPrefix}records`, initial.id)
      expect(JSON.parse(raw ?? 'null')).toEqual({
        id: initial.id,
        workspace_id: initial.workspaceId,
        session_id: initial.sessionId,
        command: initial.command,
        submitted_at: initial.submittedAt,
        status: 'done',
        revision: 1,
        cancel_requested: false,
        started_at: null,
        finished_at: finished.finishedAt,
        result: { empty: [], nested: {}, stdout: ['hé'] },
        error: null,
      })
      expect(await client.ttl(`${first.keyPrefix}records`)).toBe(-1)
    } finally {
      await client.quit()
    }
    await first.close()
    expect(await second.get(initial.id)).toEqual(finished)
  })

  it('prunes only completed records, including terminal records created directly', async () => {
    const store = makeStore(undefined, 2, 10)
    const now = Date.now()
    const active = record('active', 'other')
    await store.create(active)
    for (let i = 0; i < 3; i++) {
      const initial = record(String(i))
      await store.create(initial)
      await store.compareAndSet(
        { ...initial, revision: 1, status: ExecutionStatus.DONE, finishedAt: now / 1000 + i },
        0,
      )
    }
    expect(await store.get('0')).toBeNull()
    expect(await store.list('workspace')).toHaveLength(2)
    vi.spyOn(Date, 'now').mockReturnValue(now + 13_000)
    expect(await store.list()).toEqual([active])
    const terminal = {
      ...active,
      id: 'already-done',
      status: ExecutionStatus.DONE,
      finishedAt: now / 1000,
    }
    await store.create(terminal)
    expect(await store.get(terminal.id)).toBeNull()
  })

  it('close releases pending waits and refuses reconnection without deleting records', async () => {
    const first = makeStore()
    const second = makeStore(first.keyPrefix)
    const initial = record('one')
    await first.create(initial)
    const waiting = second.waitForChange(initial.id, 0)
    const stopped = expect(waiting).rejects.toThrow('closed')
    await new Promise((resolve) => setTimeout(resolve, 30))
    await second.close()
    await stopped
    await expect(second.get(initial.id)).rejects.toThrow('closed')
    expect(await first.get(initial.id)).toEqual(initial)
    await second.close()
  })
})
