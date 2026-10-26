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

import { randomUUID } from 'node:crypto'
import { createClient } from 'redis'
import { Channel } from '@struktoai/mirage-core/shell/console/index'
import { JobTable } from '@struktoai/mirage-core/shell/job_table/table'
import { type Job, type JobRunner, JobStatus } from '@struktoai/mirage-core/shell/job_table/types'
import { afterEach, describe, expect, it } from 'vitest'
import { RedisJobStore } from './redis.ts'

const REDIS_URL = process.env.REDIS_URL ?? ''
const DEC = new TextDecoder()

/** A runner that ends only through its abort. */
function pending(abort: AbortController): JobRunner {
  return () =>
    new Promise((_resolve, reject) => {
      abort.signal.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      })
    })
}

describe.skipIf(REDIS_URL === '')('RedisJobStore', () => {
  let prefix = ''
  const opened: RedisJobStore[] = []

  function open(leaseSeconds: number | null = 30): RedisJobStore {
    if (opened.length === 0) prefix = `test:jobs:${randomUUID()}:`
    const store = new RedisJobStore({ url: REDIS_URL, keyPrefix: prefix, leaseSeconds })
    opened.push(store)
    return store
  }

  async function sleeping(jt: JobTable): Promise<Job> {
    const abort = new AbortController()
    return jt.submit({ command: 'sleep 30', run: pending(abort), abort, cwd: '/', sessionId: 's' })
  }

  afterEach(async () => {
    await opened[0]?.clear()
    for (const store of opened.splice(0)) await store.close()
  })

  it('writes a list under its generation', async () => {
    const store = open()
    expect(await store.load('s')).toBeNull()
    expect(await store.casSet('s', { next: 2, generation: 1 }, 0)).toBe(true)
    expect(await store.casSet('s', { next: 3, generation: 1 }, 0)).toBe(false)
    expect(await store.load('s')).toEqual({ next: 2, generation: 1 })
    await store.delete('s')
    expect(await store.load('s')).toBeNull()
  })

  it('reaches one stream from any store by console name', async () => {
    const first = open()
    const second = open()
    await first.console('c').append(Channel.STDOUT, new TextEncoder().encode('hi'))
    const [chunks] = await second.console('c').readFrom(0)
    expect(chunks.map((c) => DEC.decode(c.data))).toEqual(['hi'])
  })

  it('keeps an owner alive while its lease holds', async () => {
    const store = open(0.2)
    expect(await store.alive('o')).toBe(false)
    await store.renew('o')
    expect(await store.alive('o')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await store.alive('o')).toBe(false)
  })

  it('clear drops lists, consoles and leases', async () => {
    const store = open()
    await store.casSet('s', { generation: 1 }, 0)
    await store.console('c').append(Channel.STDOUT, new TextEncoder().encode('x'))
    await store.renew('o')
    await store.clear()
    expect(await store.load('s')).toBeNull()
    const client = createClient({ url: REDIS_URL })
    await client.connect()
    const keys: string[] = []
    for await (const k of client.scanIterator({ MATCH: `${prefix}*` })) {
      keys.push(...(Array.isArray(k) ? k : [k]))
    }
    await client.quit()
    expect(keys).toEqual([])
  })

  it('lets a table on another store kill and wait on a job', async () => {
    const a = new JobTable(open())
    const b = new JobTable(open())
    const job = await sleeping(a)
    await b.sync('s')
    expect(b.listJobs('s').map((j) => j.status)).toEqual([JobStatus.RUNNING])
    expect(await b.kill(1, 's', 15)).toBe(true)
    expect((await b.wait(1, 's')).exitCode).toBe(143)
    await job.process?.join()
    expect([job.status, job.exitCode]).toEqual([JobStatus.KILLED, 143])
    await a.close()
  })

  it('ends a job whose owner died as hung up', async () => {
    const a = new JobTable(open(0.3))
    const b = new JobTable(open(0.3))
    await sleeping(a)
    const owner = a as unknown as { lease: ReturnType<typeof setTimeout> | null }
    expect(owner.lease).not.toBeNull()
    if (owner.lease !== null) clearTimeout(owner.lease)
    await b.sync('s')
    expect((await b.wait(1, 's')).exitCode).toBe(129)
    await a.killAll()
  })
})
