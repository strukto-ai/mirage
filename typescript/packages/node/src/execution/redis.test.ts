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
import { JobTable } from '@struktoai/mirage-core/execution/job/table'
import type { JobHandle, JobRunner } from '@struktoai/mirage-core/execution/job/handle'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HISTORY_MAX_RECORDS } from '@struktoai/mirage-core/execution/constants'
import type { Line } from '@struktoai/mirage-core/execution/line/types'
import type { Process } from '@struktoai/mirage-core/execution/process/types'
import { LineId, MachineName, ProcessId } from '@struktoai/mirage-core/execution/types'
import { PathSpec } from '@struktoai/mirage-core/types'
import { RedisExecutionStore } from './redis.ts'

const REDIS_URL = process.env.REDIS_URL ?? ''
const DEC = new TextDecoder()

function lineOf(n: number, endedAt: number | null = null): Line {
  return {
    id: new LineId(`line_${String(n)}`),
    sessionId: 's',
    command: `echo ${String(n)}`,
    startedAt: n,
    state: endedAt === null ? 'running' : 'exited',
    endedAt,
    exit: endedAt === null ? null : 0,
    signal: null,
    error: null,
  }
}

/** A runner that ends only through its abort. */
function pending(abort: AbortController): JobRunner {
  return () =>
    new Promise((_resolve, reject) => {
      abort.signal.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      })
    })
}

async function keysUnder(prefix: string): Promise<string[]> {
  const c = createClient({ url: REDIS_URL })
  await c.connect()
  const keys: string[] = []
  for await (const k of c.scanIterator({ MATCH: `${prefix}*` })) {
    keys.push(...(Array.isArray(k) ? k : [k]))
  }
  await c.quit()
  return keys.sort()
}

describe.skipIf(REDIS_URL === '')('RedisExecutionStore', () => {
  let prefix = ''
  const opened: RedisExecutionStore[] = []

  function open(leaseSeconds: number | null = 30): RedisExecutionStore {
    if (opened.length === 0) prefix = `test:jobs:${randomUUID()}:`
    const store = new RedisExecutionStore({ url: REDIS_URL, keyPrefix: prefix, leaseSeconds })
    opened.push(store)
    return store
  }

  async function sleeping(jt: JobTable): Promise<JobHandle> {
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
    expect(await store.sessions()).toEqual(['s'])
    expect(await store.casSet('s', { next: 3, generation: 1 }, 0)).toBe(false)
    expect(await store.load('s')).toEqual({ next: 2, generation: 1 })
    expect(await store.delete('s', 0)).toBe(false)
    expect(await store.load('s')).toEqual({ next: 2, generation: 1 })
    expect(await store.delete('s', 1)).toBe(true)
    expect(await store.load('s')).toBeNull()
  })

  it('reaches one stream from any store by console name', async () => {
    const first = open()
    const second = open()
    await first.console('c').append(Channel.STDOUT, new TextEncoder().encode('hi'))
    const [chunks] = await second.console('c').readFrom(0)
    expect(chunks.map((c) => DEC.decode(c.data))).toEqual(['hi'])
  })

  it('lets one daemon hold the lease while it renews', async () => {
    const [a, b] = [open(0.2), open(0.2)]
    expect(await a.holder()).toBeNull()
    expect(await a.lease('a')).toBeNull()
    expect(await b.lease('b')).toBe('a')
    expect(await b.holder()).toBe('a')
    await b.release('b')
    expect(await a.lease('a')).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await b.holder()).toBeNull()
    expect(await b.lease('b')).toBeNull()
    expect(await a.lease('a')).toBe('b')
    await b.release('b')
    expect(await a.holder()).toBeNull()
  })

  it('only raises the highest pid, on every store', async () => {
    const [a, b] = [open(), open()]
    expect(await b.highestPid()).toBe(0)
    await a.publish('a', {}, 7)
    await b.publish('b', {}, 3)
    expect(await a.highestPid()).toBe(7)
    expect(await b.highestPid()).toBe(7)
  })

  it("a renewal keeps a running job's console", async () => {
    const store = open()
    await store.console('c').append(Channel.STDOUT, new TextEncoder().encode('x'))
    const client = createClient({ url: REDIS_URL })
    await client.connect()
    await client.expire(`${prefix}console:c:stream`, 5)
    store.note(lineOf(1))
    await vi.waitFor(async () => {
      expect(await client.exists(`${prefix}records:lines`)).toBe(1)
    })
    await client.expire(`${prefix}records:lines`, 5)
    await store.lease('o', ['c'])
    const ttl = await client.ttl(`${prefix}console:c:stream`)
    const records = await client.ttl(`${prefix}records:lines`)
    await client.quit()
    expect(ttl).toBeGreaterThan(5)
    expect(records).toBeGreaterThan(5)
  })

  it.each(['', 'a:b', 'sessions'])(
    'refuses the name %j, which the key filter would not count',
    async (name) => {
      const store = open()
      expect(() => store.console(name)).toThrow()
      await expect(store.publish(name, { '1': { pid: 1 } }, 1)).rejects.toThrow()
      await expect(store.requestStop(name, 1, 15)).rejects.toThrow()
    },
  )

  it('matches a glob character in the prefix only as itself', async () => {
    const base = `test:jobs:${randomUUID()}:`
    const doomed = new RedisExecutionStore({ url: REDIS_URL, keyPrefix: `${base}w?:` })
    const kept = new RedisExecutionStore({ url: REDIS_URL, keyPrefix: `${base}w1:` })
    try {
      await kept.casSet('s', { generation: 1 }, 0)
      await kept.lease('k')
      await kept.publish('k', { '7': { pid: 7 } }, 7)
      const keptKeys = await keysUnder(base)
      await doomed.publish('d', { '8': { pid: 8 } }, 8)
      expect(Object.keys(await doomed.processes())).toEqual(['d'])
      await doomed.clear()
      expect(await keysUnder(base)).toEqual(keptKeys)
    } finally {
      await doomed.clear()
      await kept.clear()
      await doomed.close()
      await kept.close()
    }
  })

  it('clear drops every key the store writes', async () => {
    const store = open()
    await store.casSet('s', { generation: 1 }, 0)
    await store.console('c').append(Channel.STDOUT, new TextEncoder().encode('x'))
    await store.lease('o')
    await store.publish('o', { '4': { pid: 4 } }, 4)
    await store.requestStop('o', 4, 15)
    store.note(lineOf(1, 2))
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

  it("reaches a daemon's processes and stops from every store, and drops them", async () => {
    const [a, b] = [open(), open()]
    const record = { pid: 2, command: 'sleep 30', runs: [] }
    await a.publish('a', { '2': record }, 2)
    expect(await b.processes()).toEqual({ a: { '2': record } })
    await b.requestStop('a', 2, 15)
    await b.requestStop('a', 3, 9)
    expect(await a.takeStops('a')).toEqual([
      [2, 15],
      [3, 9],
    ])
    expect(await a.takeStops('a')).toEqual([])
    await a.publish('a', {})
    expect(await b.processes()).toEqual({})
    const client = createClient({ url: REDIS_URL })
    await client.connect()
    const keys: string[] = []
    for await (const k of client.scanIterator({ MATCH: `${prefix}*` })) {
      keys.push(...(Array.isArray(k) ? k : [k]))
    }
    await client.quit()
    expect(keys).toEqual([`${prefix}pid`])
  })

  it('lets a table on another store kill and wait on a job', async () => {
    const a = new JobTable(open())
    const b = new JobTable(open())
    const job = await sleeping(a)
    await b.sync('s')
    expect(b.listJobs('s').map((j) => j.state)).toEqual(['running'])
    expect(await b.kill(1, 's', 15)).toBe(true)
    expect((await b.wait(1, 's')).exitCode).toBe(143)
    await job.process?.join()
    expect([job.signal, job.exitCode]).toEqual([15, 143])
    await a.close()
  })

  it('ends a job whose daemon died as hung up', async () => {
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
  // A record noted on one store reaches every store on the server once it is
  // written, the newest of each winning, with every field it was noted with.
  it('brings a noted record to every store', async () => {
    const a = open()
    const b = open()
    const process: Process = {
      id: new ProcessId('w', 7),
      sessionId: 's',
      line: new LineId('line_1'),
      parent: 3,
      group: 3,
      command: 'sleep 30',
      cwd: PathSpec.fromStrPath('/m'),
      machine: new MachineName('docker', 'tools'),
      startedAt: 1.5,
      runtime: 'docker',
      machinePid: { pid: 4242, started: 1.25, exited: null },
      state: 'stopping',
      endedAt: null,
      exit: null,
      signal: null,
      error: null,
      ancestors: [1, 3],
      machineInstance: 'tools-1',
      stdin: 2,
      fd: { 63: 4 },
      argv: [5],
    }
    a.note(lineOf(1))
    a.note(lineOf(1, 2))
    a.note(process)
    expect(await a.getLine(new LineId('line_1'))).toEqual(lineOf(1, 2))
    await vi.waitFor(async () => {
      expect(await b.findProcesses()).toHaveLength(1)
    })
    expect(await b.getProcess(new ProcessId('w', 7))).toEqual(process)
    expect(await b.findLines()).toEqual([lineOf(1, 2)])
    expect(await b.findLines('other')).toEqual([])
  })

  // Ended records are kept to the history, and a running one stays.
  it('keeps ended records to the history', async () => {
    const a = open()
    const b = open()
    a.note(lineOf(0))
    for (let n = 1; n < HISTORY_MAX_RECORDS + 3; n++) a.note(lineOf(n, n))
    const newest = `line_${String(HISTORY_MAX_RECORDS + 2)}`
    await vi.waitFor(async () => {
      expect((await b.findLines()).map((r) => r.id.value)).toContain(newest)
    })
    const kept = (await b.findLines()).map((r) => r.id.value)
    expect(kept).toHaveLength(HISTORY_MAX_RECORDS + 1)
    expect(kept.slice(0, 2)).toEqual(['line_0', 'line_3'])
  })
})
