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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '../shell/console/index.ts'
import { PathSpec } from '../types.ts'
import type { SqlDriver } from '../vfs/sql/types.ts'
import { fileDriver } from '../../tests/workspace/fixtures/sqlite_driver.ts'
import { HISTORY_MAX_RECORDS, HISTORY_SECONDS } from './constants.ts'
import type { JobHandle, JobRunner } from './job/handle.ts'
import { JobTable } from './job/table.ts'
import type { Line } from './line/types.ts'
import type { Process } from './process/types.ts'
import { SqlExecutionStore } from './sql.ts'
import { LineId, MachineId, ProcessId } from './types.ts'

const enc = new TextEncoder()

/** A runner that ends only through its abort. */
function pending(abort: AbortController): JobRunner {
  return () =>
    new Promise((_resolve, reject) => {
      abort.signal.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      })
    })
}

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

describe('SqlExecutionStore', () => {
  let dir = ''
  const drivers: SqlDriver[] = []
  const opened: SqlExecutionStore[] = []

  function open(leaseSeconds: number | null = 30): SqlExecutionStore {
    if (dir === '') dir = mkdtempSync(join(tmpdir(), 'mirage-execution-'))
    const driver = fileDriver(join(dir, 'execution.db'))
    drivers.push(driver)
    const store = new SqlExecutionStore(driver, 'test/', leaseSeconds)
    opened.push(store)
    return store
  }

  afterEach(async () => {
    for (const store of opened.splice(0)) await store.close()
    for (const driver of drivers.splice(0)) await driver.close()
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('writes a list under its generation', async () => {
    const store = open()
    expect(await store.load('s')).toBeNull()
    expect(await store.casSet('s', { next: 2, generation: 1 }, 0)).toBe(true)
    expect(await store.casSet('s', { next: 3, generation: 1 }, 0)).toBe(false)
    expect(await store.load('s')).toEqual({ next: 2, generation: 1 })
    expect(await store.casSet('s', { next: 3, generation: 2 }, 1)).toBe(true)
    expect(await store.casSet('s', { next: 4, generation: 3 }, 1)).toBe(false)
    expect(await store.delete('s', 0)).toBe(false)
    expect(await store.delete('s', 2)).toBe(true)
    expect(await store.load('s')).toBeNull()
    expect(await store.delete('s', 0)).toBe(true)
  })

  // A console is one stream every store on the database reaches by name; a
  // reader waiting on another store wakes once a chunk or the ending lands,
  // and nothing is appended past the ending.
  it('brings a console to every store and ends it once', async () => {
    const writer = open().console('c')
    const reader = open().console('c')
    const waiting = reader.wait(1)
    expect((await writer.append(Channel.STDOUT, enc.encode('hi'))).seq).toBe(0)
    expect((await writer.append(Channel.STDERR, enc.encode('oops'))).seq).toBe(1)
    await waiting
    const [chunks, cursor, dropped] = await reader.readFrom(0)
    expect(chunks.map((c) => [c.channel, new TextDecoder().decode(c.data)])).toEqual([
      [Channel.STDOUT, 'hi'],
      [Channel.STDERR, 'oops'],
    ])
    expect([cursor, dropped]).toEqual([2, false])
    const ended = writer.waitEnded()
    await reader.append(Channel.CONTROL, enc.encode('exit:0'))
    await ended
    const late = await writer.append(Channel.STDOUT, enc.encode('late'))
    expect([late.seq, late.channel]).toEqual([2, Channel.CONTROL])
    expect((await reader.readFrom(0))[0]).toHaveLength(3)
  })

  it('drops a console once no list names it', async () => {
    const store = open()
    await store.console('c').append(Channel.STDOUT, enc.encode('x'))
    expect(await store.casSet('s', { jobs: { 1: { console: 'c' } }, generation: 1 }, 0)).toBe(true)
    expect(await store.casSet('s', { jobs: {}, generation: 2 }, 1)).toBe(true)
    expect((await open().console('c').readFrom(0))[0]).toEqual([])
  })

  it('lets one daemon hold the lease while it renews', async () => {
    const a = open(0.2)
    const b = open(0.2)
    expect(await a.holder()).toBeNull()
    expect(await a.lease('a')).toBeNull()
    expect(await b.lease('b')).toBe('a')
    await b.release('b')
    expect(await a.lease('a')).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await b.holder()).toBeNull()
    expect(await b.lease('b')).toBeNull()
    expect(await a.lease('a')).toBe('b')
  })

  it('brings a daemon’s processes and stops to every store', async () => {
    const a = open()
    const b = open()
    await a.publish('a', { 2: { pid: 2 } }, 7)
    await b.publish('b', {}, 3)
    expect(await b.processes()).toEqual({ a: { 2: { pid: 2 } } })
    expect(await b.highestPid()).toBe(7)
    await b.requestStop('a', 2, 15)
    await b.requestStop('a', 3, 9)
    expect(await a.takeStops('a')).toEqual([
      [2, 15],
      [3, 9],
    ])
    expect(await a.takeStops('a')).toEqual([])
    await a.publish('a', {})
    expect(await b.processes()).toEqual({})
  })

  it('lets a table on another store kill and wait on a job', async () => {
    const a = new JobTable(open())
    const b = new JobTable(open())
    const abort = new AbortController()
    const job: JobHandle = await a.submit({
      command: 'sleep 30',
      run: pending(abort),
      abort,
      cwd: '/',
      sessionId: 's',
    })
    await b.sync('s')
    expect(b.listJobs('s').map((j) => j.state)).toEqual(['running'])
    expect(await b.kill(1, 's', 15)).toBe(true)
    expect((await b.wait(1, 's')).exitCode).toBe(143)
    await job.process?.join()
    expect([job.signal, job.exitCode]).toEqual([15, 143])
    await a.close()
  })

  // A record noted on one store reaches every store on the database once it
  // is written, the newest of each winning, with every field it was noted
  // with; ended ones are kept to the history.
  it('brings noted records to every store and keeps the history', async () => {
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
      machine: new MachineId('docker', 'tools'),
      startedAt: 1.5,
      runtime: 'docker',
      machinePid: { pid: 4242, started: 1.25, exited: null },
      state: 'stopping',
      endedAt: null,
      exit: null,
      signal: null,
      error: null,
    }
    a.note(process)
    a.note(lineOf(0))
    for (let n = 1; n < HISTORY_MAX_RECORDS + 3; n++) a.note(lineOf(n, n))
    const newest = `line_${String(HISTORY_MAX_RECORDS + 2)}`
    await vi.waitFor(async () => {
      expect((await b.findLines()).map((r) => r.id.value)).toContain(newest)
    })
    expect(await b.getProcess(new ProcessId('w', 7))).toEqual(process)
    let kept = (await b.findLines()).map((r) => r.id.value)
    expect(kept).toHaveLength(HISTORY_MAX_RECORDS + 1)
    expect(kept.slice(0, 2)).toEqual(['line_0', 'line_3'])
    a.note(lineOf(5000, HISTORY_SECONDS + 1000.5))
    await vi.waitFor(async () => {
      expect((await b.findLines()).map((r) => r.id.value)).toContain('line_5000')
    })
    kept = (await b.findLines()).map((r) => r.id.value)
    expect(kept.slice(0, 3)).toEqual(['line_0', 'line_1001', 'line_1002'])
    expect(kept).toHaveLength(28)
  })

  it('clears its lists, consoles, records and the lease', async () => {
    const store = open()
    await store.casSet('s', { generation: 1 }, 0)
    await store.console('c').append(Channel.STDOUT, enc.encode('x'))
    await store.lease('o')
    await store.publish('o', { 1: {} }, 4)
    store.note(lineOf(1))
    await store.clear()
    const other = open()
    expect(await other.load('s')).toBeNull()
    expect((await other.console('c').readFrom(0))[0]).toEqual([])
    expect(await other.holder()).toBeNull()
    expect(await other.processes()).toEqual({})
    expect(await other.highestPid()).toBe(0)
    expect(await other.findLines()).toEqual([])
  })
})
