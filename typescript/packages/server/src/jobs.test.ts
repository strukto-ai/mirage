// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { describe, expect, it } from 'vitest'
import { RAMExecutionStore } from '@struktoai/mirage-core/execution/ram'
import type { ExecutionRecord } from '@struktoai/mirage-core/execution/types'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { JobStatus, JobTable } from './jobs.ts'

function gate() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

async function submit(table: JobTable, work: (signal: AbortSignal) => Promise<JsonValue>) {
  return table.submit(
    'ws',
    'probe',
    async (signal, scope) => {
      await scope.start()
      signal.throwIfAborted()
      return work(signal)
    },
    'session',
  )
}

describe('async execution ownership', () => {
  it('store outages cannot prevent local cancellation or interrupt cleanup', async () => {
    const entered = gate(),
      cleanup = gate(),
      release = gate()
    class BrokenStore extends RAMExecutionStore {
      offline = false
      override async get(id: string): Promise<ExecutionRecord | null> {
        if (this.offline) throw new Error('storage unavailable')
        return super.get(id)
      }
    }
    const store = new BrokenStore()
    const table = new JobTable(store)
    const job = await submit(table, async (signal) => {
      entered.release()
      try {
        await new Promise<void>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('aborted', 'AbortError'))
            },
            { once: true },
          )
        })
      } finally {
        cleanup.release()
        await release.wait
      }
      return null
    })
    await entered.wait
    store.offline = true
    await expect(table.cancel(job.id)).rejects.toThrow('storage unavailable')
    await cleanup.wait
    let drained = false
    const draining = table.drain(job.id).then(() => {
      drained = true
    })
    await expect(table.cancel(job.id)).rejects.toThrow('storage unavailable')
    await Promise.resolve()
    expect(drained).toBe(false)
    release.release()
    await draining
    store.offline = false
    expect((await store.get(job.id))?.finishedAt).toBeNull()
    await table.close()
    await store.close()
  })
  it('passes the persisted execution identity into admission scope', async () => {
    const table = new JobTable()
    const job = await table.submit(
      'ws',
      'probe',
      async (_signal, scope) => {
        await scope.start()
        return scope.id
      },
      'session',
    )
    expect((await table.wait(job.id)).result).toBe(job.id)
    await table.close()
  })

  it('retains stopping until cleanup, and a wait timeout does not cancel work', async () => {
    const entered = gate(),
      cleanup = gate(),
      release = gate()
    const table = new JobTable()
    const job = await submit(table, async (signal) => {
      entered.release()
      try {
        await new Promise<void>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('aborted', 'AbortError'))
            },
            { once: true },
          )
        })
      } finally {
        cleanup.release()
        await release.wait
      }
      return null
    })
    await entered.wait
    expect((await table.wait(job.id, 0)).status).toBe(JobStatus.RUNNING)
    expect(await table.cancel(job.id)).toBe(true)
    await cleanup.wait
    const stopping = await table.wait(job.id, 0.001)
    expect(stopping.status).toBe(JobStatus.STOPPING)
    expect(stopping.finishedAt).toBeNull()
    expect(await table.cancel(job.id)).toBe(false)
    release.release()
    expect((await table.wait(job.id)).status).toBe(JobStatus.CANCELED)
    expect(await table.cancel(job.id)).toBe(false)
    await table.close()
  })

  it('cancel before session acquisition never calls the body', async () => {
    const acquired = gate()
    let invoked = false
    const table = new JobTable()
    const job = await table.submit(
      'ws',
      'probe',
      async (_signal, scope) => {
        await acquired.wait
        await scope.start()
        invoked = true
        return null
      },
      'session',
    )
    expect(job.status).toBe(JobStatus.PENDING)
    expect(await table.cancel(job.id)).toBe(true)
    acquired.release()
    const finished = await table.wait(job.id)
    expect(finished.status).toBe(JobStatus.CANCELED)
    expect(finished.startedAt).toBeNull()
    expect(invoked).toBe(false)
    await table.close()
  })

  it('failed admission starts nothing', async () => {
    class BrokenStore extends RAMExecutionStore {
      override create(): Promise<boolean> {
        return Promise.reject(new Error('store unavailable'))
      }
    }
    let invoked = false
    const table = new JobTable(new BrokenStore())
    await expect(
      submit(table, () => {
        invoked = true
        return Promise.resolve(null)
      }),
    ).rejects.toThrow('unavailable')
    expect(invoked).toBe(false)
  })

  it('a stalled store cannot keep cancelled work running', async () => {
    const entered = gate(),
      cleanup = gate(),
      resume = gate()
    class StalledStore extends RAMExecutionStore {
      stalled = false
      override async get(id: string): Promise<ExecutionRecord | null> {
        if (this.stalled) await resume.wait
        return super.get(id)
      }
    }
    const store = new StalledStore()
    const table = new JobTable(store)
    const job = await submit(table, async (signal) => {
      entered.release()
      try {
        await new Promise<void>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('aborted', 'AbortError'))
            },
            { once: true },
          )
        })
      } finally {
        cleanup.release()
      }
      return null
    })
    await entered.wait
    store.stalled = true
    let cancelled = false
    const cancelling = table.cancel(job.id).then((accepted) => {
      cancelled = true
      return accepted
    })
    try {
      await cleanup.wait
      expect(cancelled).toBe(false)
    } finally {
      resume.release()
    }
    expect(await cancelling).toBe(true)
    expect((await table.wait(job.id)).status).toBe(JobStatus.CANCELED)
    await table.close()
    await store.close()
  })
  it('cancellation survives a delayed completion CAS', async () => {
    const completing = gate(),
      release = gate()
    class DelayedStore extends RAMExecutionStore {
      override async compareAndSet(record: ExecutionRecord, revision: number): Promise<boolean> {
        if (record.status === JobStatus.DONE) {
          completing.release()
          await release.wait
        }
        return super.compareAndSet(record, revision)
      }
    }
    const table = new JobTable(new DelayedStore())
    const job = await submit(table, () => Promise.resolve({ exitCode: 1 }))
    await completing.wait
    expect(await table.cancel(job.id)).toBe(true)
    release.release()
    const finished = await table.wait(job.id)
    expect(finished.status).toBe(JobStatus.CANCELED)
    expect(finished.cancelRequested).toBe(true)
    expect(finished.result).toBeNull()
    expect(finished.revision).toBe(3)
  })

  it('a wait keeps the completion it observed', async () => {
    class EvictingStore extends RAMExecutionStore {
      evicted = false
      override async get(id: string): Promise<ExecutionRecord | null> {
        return this.evicted ? null : super.get(id)
      }
      override async waitForChange(
        id: string,
        revision: number,
        timeoutSeconds?: number,
        signal?: AbortSignal,
      ): Promise<ExecutionRecord | null> {
        const record = await super.waitForChange(id, revision, timeoutSeconds, signal)
        this.evicted = record?.finishedAt != null
        return record
      }
    }
    const table = new JobTable(new EvictingStore())
    const job = await submit(table, () => Promise.resolve('value'))
    const finished = await table.wait(job.id)
    expect(finished.status).toBe(JobStatus.DONE)
    expect(finished.result).toBe('value')
  })

  it('failed completion stays unconfirmed and wakes its waiter', async () => {
    const release = gate()
    class BrokenStore extends RAMExecutionStore {
      override async compareAndSet(record: ExecutionRecord, revision: number): Promise<boolean> {
        if (record.finishedAt !== null) throw new Error('store unavailable')
        return super.compareAndSet(record, revision)
      }
    }
    const table = new JobTable(new BrokenStore())
    const job = await submit(table, async () => {
      await release.wait
      return 'value'
    })
    const outcome = expect(table.wait(job.id)).rejects.toThrow('could not be published')
    await new Promise((resolve) => setTimeout(resolve, 10))
    const released = performance.now()
    release.release()
    await outcome
    expect(performance.now() - released).toBeLessThan(500)
    expect((await table.get(job.id)).finishedAt).toBeNull()
  })

  it('distinguishes command outcomes from service failures', async () => {
    const table = new JobTable()
    const command = await submit(table, () => Promise.resolve({ exitCode: 1 }))
    const service = await submit(table, () => Promise.reject(new Error('broken runtime')))
    expect((await table.wait(command.id)).status).toBe(JobStatus.DONE)
    expect((await table.wait(service.id)).status).toBe(JobStatus.FAILED)
    expect((await table.get(service.id)).error).toContain('broken runtime')
    await table.close()
  })

  it('shutdown during admission never schedules work', async () => {
    const creating = gate(),
      release = gate()
    class DelayedStore extends RAMExecutionStore {
      override async create(record: ExecutionRecord): Promise<boolean> {
        creating.release()
        await release.wait
        return super.create(record)
      }
    }
    const store = new DelayedStore()
    const table = new JobTable(store)
    let invoked = false
    const submission = submit(table, () => {
      invoked = true
      return Promise.resolve(null)
    })
    await creating.wait
    await table.close()
    release.release()
    await expect(submission).rejects.toThrow('closed')
    const records = await store.list()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ status: JobStatus.CANCELED, startedAt: null })
    expect(records[0]?.finishedAt).not.toBeNull()
    expect(invoked).toBe(false)
    await store.close()
  })

  it('shutdown joins every runner even when cancel writes fail', async () => {
    const release = gate()
    class BrokenStore extends RAMExecutionStore {
      override async compareAndSet(record: ExecutionRecord, revision: number): Promise<boolean> {
        if (record.status === JobStatus.STOPPING) throw new Error('cancel storage unavailable')
        return super.compareAndSet(record, revision)
      }
    }
    const store = new BrokenStore()
    const table = new JobTable(store)
    const probes = [0, 1].map(() => ({ entered: gate(), cleanup: gate() }))
    const jobs = await Promise.all(
      probes.map((probe) =>
        submit(table, async (signal) => {
          probe.entered.release()
          try {
            await new Promise<void>((_, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  reject(new DOMException('aborted', 'AbortError'))
                },
                { once: true },
              )
            })
          } finally {
            probe.cleanup.release()
            await release.wait
          }
          return null
        }),
      ),
    )
    await Promise.all(probes.map((p) => p.entered.wait))
    let closed = false
    const closing = table.close().finally(() => {
      closed = true
    })
    await Promise.all(probes.map((p) => p.cleanup.wait))
    expect(closed).toBe(false)
    release.release()
    await expect(closing).rejects.toThrow('shutdown cancellation')
    for (const job of jobs) {
      const record = await store.get(job.id)
      expect(record).toMatchObject({ status: JobStatus.CANCELED, cancelRequested: true })
      expect(record?.finishedAt).not.toBeNull()
    }
    await store.close()
  })
})
