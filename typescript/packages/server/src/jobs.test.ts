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

import { describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { JobStatus, JobTable } from './jobs.ts'

function gate() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

function submit(table: JobTable, work: (signal: AbortSignal) => Promise<JsonValue>) {
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
  it('passes the persisted execution identity into admission scope', async () => {
    const table = new JobTable()
    const job = table.submit(
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
    const job = submit(table, async (signal) => {
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
    expect(table.cancel(job.id)).toBe(true)
    await cleanup.wait
    const stopping = await table.wait(job.id, 0.001)
    expect(stopping.status).toBe(JobStatus.STOPPING)
    expect(stopping.finishedAt).toBeNull()
    expect(table.cancel(job.id)).toBe(false)
    release.release()
    expect((await table.wait(job.id)).status).toBe(JobStatus.CANCELED)
    expect(table.cancel(job.id)).toBe(false)
    await table.close()
  })

  it('cancel before session acquisition never calls the body', async () => {
    const acquired = gate()
    let invoked = false
    const table = new JobTable()
    const job = table.submit(
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
    expect(table.cancel(job.id)).toBe(true)
    acquired.release()
    const finished = await table.wait(job.id)
    expect(finished.status).toBe(JobStatus.CANCELED)
    expect(finished.startedAt).toBeNull()
    expect(invoked).toBe(false)
    await table.close()
  })

  it('distinguishes command outcomes from service failures', async () => {
    const table = new JobTable()
    const command = submit(table, () => Promise.resolve({ exitCode: 1 }))
    const service = submit(table, () => Promise.reject(new Error('broken runtime')))
    expect((await table.wait(command.id)).status).toBe(JobStatus.DONE)
    expect((await table.wait(service.id)).status).toBe(JobStatus.FAILED)
    expect(table.get(service.id)?.error).toContain('broken runtime')
    await table.close()
  })

  it('an aborted join cancels the work and waits for its cleanup', async () => {
    const entered = gate()
    let cleaned = false
    const table = new JobTable()
    const job = submit(table, async (signal) => {
      entered.release()
      try {
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      } finally {
        await Promise.resolve()
        cleaned = true
      }
      return null
    })
    const abort = new AbortController()
    const joined = table.join(job.id, abort.signal)
    await entered.wait
    abort.abort()
    expect((await joined).status).toBe(JobStatus.CANCELED)
    expect(cleaned).toBe(true)
    await table.close()
  })

  it('close cancels running work and joins it', async () => {
    const entered = gate()
    let cleaned = false
    const table = new JobTable()
    const job = submit(table, async (signal) => {
      entered.release()
      try {
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      } finally {
        cleaned = true
      }
      return null
    })
    await entered.wait
    await table.close()
    expect(cleaned).toBe(true)
    expect(table.get(job.id)?.status).toBe(JobStatus.CANCELED)
    expect(() => submit(table, () => Promise.resolve(null))).toThrow('closed')
  })

  it('drops finished records after an hour', async () => {
    const table = new JobTable()
    const job = submit(table, () => Promise.resolve(null))
    await table.wait(job.id)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 3601_000)
      expect(table.list()).toEqual([])
      expect(table.get(job.id)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
    await table.close()
  })
})
