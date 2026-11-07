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
import type { LineHandle } from '@struktoai/mirage-core/execution/line/handle'
import { MountMode } from '@struktoai/mirage-core/types'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '@struktoai/mirage-node'
import { RequestTable } from './requests.ts'

function gate() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

function submit(
  table: RequestTable,
  work: (signal: AbortSignal) => Promise<JsonValue>,
  workspaceId = 'ws',
) {
  return table.submit(
    workspaceId,
    'probe',
    async (signal, line) => {
      await line.start()
      signal.throwIfAborted()
      return work(signal)
    },
    'session',
  )
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(signal.reason as Error)
    })
  })
}

describe('RequestTable', () => {
  it('lets a request go once its caller has it', async () => {
    const table = new RequestTable()
    const job = submit(table, () => Promise.resolve('private output'))
    expect(table.requests()).toEqual([job])
    const finished = await table.wait(job.id)
    expect(finished.result).toBe('private output')
    expect(finished.line.record.state).toBe('exited')
    expect(table.requests()).toEqual([])
    expect(table.cancel(job.id)).toBe(false)
    await table.close()
  })

  it('discards only the deleted workspace requests', async () => {
    const table = new RequestTable()
    const deleted = submit(table, () => Promise.resolve(null), 'deleted')
    const retained = submit(table, () => Promise.resolve(null), 'retained')
    try {
      await table.drain(deleted.id)
      await table.drain(retained.id)
      table.discardWorkspace('missing')
      table.discardWorkspace('deleted')
      table.discardWorkspace('deleted')
      expect(table.requests()).toEqual([retained])
      await expect(table.wait(deleted.id)).rejects.toThrow('request not found')
    } finally {
      await table.close()
    }
  })

  it('hands the request line to the workspace, its history and process', async () => {
    const table = new RequestTable()
    const ws = new Workspace({ '/ram': new RAMVFS() }, { mode: MountMode.WRITE })
    const seen: string[] = []
    const run = async (_signal: AbortSignal, line: LineHandle): Promise<JsonValue> => {
      seen.push(line.id.value)
      return (await ws.shell('echo tracked > /ram/file', { lineHandle: line })).exitCode
    }
    try {
      const job = table.submit('ws', 'write', run, ws.defaultSessionId)
      const finished = await table.wait(job.id)
      expect([finished.result, finished.line.record.exit]).toEqual([0, 0])
      expect(seen).toEqual([job.id.value])
      expect(ws.lineTable.get(job.id)).toBe(finished.line.record)
      const events = await ws.observer.events()
      expect(events.length).toBeGreaterThan(0)
      expect(events.every((event) => (event.id ?? event.parent) === job.id.value)).toBe(true)
    } finally {
      await table.close()
      await ws.close()
    }
  })

  it('holds the line stopping until cleanup, and a waiter does not own the work', async () => {
    const entered = gate()
    const cleanup = gate()
    const release = gate()
    const table = new RequestTable()
    const job = submit(table, async (signal) => {
      entered.release()
      try {
        return await aborted(signal)
      } finally {
        cleanup.release()
        await release.wait
      }
    })
    await entered.wait
    expect(job.line.record.state).toBe('running')
    expect(table.cancel(job.id)).toBe(true)
    await cleanup.wait
    expect(job.line.record.state).toBe('stopping')
    expect([job.cancelRequested, job.line.record.endedAt]).toEqual([true, null])
    expect(table.cancel(job.id)).toBe(false)
    release.release()
    const finished = await table.wait(job.id)
    expect([finished.line.record.signal, finished.line.record.exit]).toEqual([2, 130])
    expect(table.cancel(job.id)).toBe(false)
    await table.close()
  })

  it('never calls the body when cancelled before the session admits it', async () => {
    const invoked: boolean[] = []
    const table = new RequestTable()
    const job = submit(table, () => {
      invoked.push(true)
      return Promise.resolve(null)
    })
    expect(job.line.record.state).toBe('waiting')
    expect(table.cancel(job.id)).toBe(true)
    const finished = await table.wait(job.id)
    expect(finished.line.record.signal).toBe(2)
    expect(invoked).toEqual([])
    await table.close()
  })

  it('tells a command failure from a service failure', async () => {
    const table = new RequestTable()
    const command = submit(table, () => Promise.resolve({ exitCode: 1 }))
    const service = submit(table, () => Promise.reject(new Error('broken runtime')))
    const done = await table.wait(command.id)
    const failed = await table.wait(service.id)
    expect([done.error, done.result]).toEqual([null, { exitCode: 1 }])
    expect(failed.error).toContain('broken runtime')
    expect(failed.line.record.error).toBe(failed.error)
    await table.close()
  })

  it('cancels the work of an aborted join and waits for its cleanup', async () => {
    const entered = gate()
    let cleaned = false
    const table = new RequestTable()
    const job = submit(table, async (signal) => {
      entered.release()
      try {
        return await aborted(signal)
      } finally {
        await Promise.resolve()
        cleaned = true
      }
    })
    const caller = new AbortController()
    const joined = table.join(job.id, caller.signal)
    await entered.wait
    caller.abort()
    await joined
    expect(cleaned).toBe(true)
    expect(job.line.record.signal).toBe(2)
    await table.close()
  })

  it('cancels running work on close and joins it', async () => {
    const entered = gate()
    let cleaned = false
    const table = new RequestTable()
    const job = submit(table, async (signal) => {
      entered.release()
      try {
        return await aborted(signal)
      } finally {
        cleaned = true
      }
    })
    await entered.wait
    await table.close()
    expect(cleaned).toBe(true)
    expect(job.line.record.signal).toBe(2)
    expect(() => submit(table, () => Promise.resolve(null))).toThrow('closed')
  })
})
