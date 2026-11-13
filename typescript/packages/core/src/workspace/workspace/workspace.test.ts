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

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { stdoutStr } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { runWithSession } from '../../context/session_context.ts'
import { SessionProfile } from '../../policy/profile.ts'
import { MachineHandle } from '../../machine/handle.ts'
import type { RunResult } from '../../runtime/types.ts'
import { RAMExecutionStore } from '../../execution/ram.ts'
import type { Process } from '../../execution/process/types.ts'
import { LineId, MachineName, ProcessId } from '../../execution/types.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { ManualClock } from '../../utils/clock.ts'
import { SeededIdSource, SystemIdSource } from '../../utils/ids.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { RAMWorkspaceStateStore } from '../store/ram.ts'
import { RAMNamespaceStore } from '../mount/namespace/ram.ts'
import { applyStateDict, toStateDict } from '../snapshot/state.ts'
import type { ExecuteOptions, SessionExecuteOptions } from './types.ts'
import { Session, Workspace } from './workspace.ts'

const DEC = new TextDecoder()

const open: Workspace[] = []

afterEach(async () => {
  for (const ws of open.splice(0)) await ws.close()
})

async function seeded(): Promise<Workspace> {
  const ws = new Workspace(
    { '/repo': [new RAMVFS(), MountMode.WRITE] as const },
    {
      mode: MountMode.WRITE,
      profiles: { reviewer: SessionProfile({ paths: { hide: ['/repo/secrets'] } }) },
    },
  )
  open.push(ws)
  await ws.shell(
    'mkdir -p /repo/secrets && echo hello > /repo/README.md && echo PRIVATE > /repo/secrets/key.pem',
  )
  return ws
}

describe('Session', () => {
  it('binds both entry points to one session', async () => {
    // One object per agent: the shell entry point and the dispatcher answer
    // under the same profile, so a hide the shell honors is a hide the
    // file tool honors too.
    const ws = await seeded()
    const reviewer = await ws.session('reviewer', { profile: 'reviewer' })
    expect(reviewer).toBeInstanceOf(Session)
    expect(reviewer.sessionId).toBe('reviewer')
    expect(reviewer.state).toBe(ws.getSession('reviewer'))
    expect(stdoutStr(await reviewer.shell('cat /repo/README.md'))).toBe('hello\n')
    expect((await reviewer.shell('cat /repo/secrets/key.pem')).exitCode).toBe(1)
    expect(DEC.decode(await reviewer.vfs.read('/repo/README.md'))).toBe('hello\n')
    expect(ws.vfs.records.map((r) => [r.op, r.path]).at(-1)).toEqual(['read', '/repo/README.md'])
    await expect(reviewer.vfs.read('/repo/secrets/key.pem')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(DEC.decode(await ws.vfs.read('/repo/secrets/key.pem'))).toBe('PRIVATE\n')
    expect(await reviewer.glob('/repo/*')).toEqual(['/repo/README.md'])
    expect(await ws.glob('/repo/*')).toEqual(['/repo/README.md', '/repo/secrets'])
  })

  it('adopts an existing session and refuses a profile for it', async () => {
    const ws = await seeded()
    const first = await ws.session('reviewer', { profile: 'reviewer' })
    const again = await ws.session('reviewer')
    expect(again.state).toBe(first.state)
    await expect(ws.session('reviewer', { profile: 'reviewer' })).rejects.toThrow(/exists/)
    await expect(ws.session('reviewer', { mounts: { '/repo': 'read' } })).rejects.toThrow(/exists/)
  })

  it('adopts a persisted session before creating one', async () => {
    // A session store hydrates on first use, so a handle asked for
    // before any async entry point has run used to see an empty session
    // table, recreate a persisted session bare, and hand the next
    // flush a record that overwrote the stored profile. The entry point
    // hydrates first, so the stored session is adopted as is.
    const store = new RAMNamespaceStore()
    const build = (): Workspace => {
      const ws = new Workspace(
        { '/repo': [new RAMVFS(), MountMode.WRITE] as const },
        {
          mode: MountMode.WRITE,
          profiles: { reviewer: SessionProfile({ paths: { hide: ['/repo/secrets'] } }) },
          sessionStore: store,
        },
      )
      open.push(ws)
      return ws
    }
    const first = build()
    const created = await first.session('reviewer', { profile: 'reviewer' })
    expect(created.state.visibility.paths).not.toBeNull()
    await first.flushSessions()
    const second = build()
    const adopted = await second.session('reviewer')
    expect(adopted.state.visibility.paths).not.toBeNull()
    await expect(second.session('reviewer', { profile: 'reviewer' })).rejects.toThrow(/exists/)
  })

  it('forwards per-call options and keeps a bound session', async () => {
    const ws = await seeded()
    const reviewer = await ws.session('reviewer', { profile: 'reviewer' })
    expect(stdoutStr(await reviewer.shell('pwd', { cwd: '/repo' }))).toBe('/repo\n')
    expect(reviewer.state.cwd).not.toBe('/repo')
    await runWithSession(ws.getSession(ws.defaultSessionId), async () => {
      // A session already bound is kept by the dispatcher, so a handle
      // reached from inside the default session's own command reads
      // as that session, never wider.
      expect(DEC.decode(await reviewer.vfs.read('/repo/secrets/key.pem'))).toBe('PRIVATE\n')
    })
  })
})

describe('handle parity with the workspace entry point', () => {
  it('forwards every option the workspace takes but the bound one', () => {
    // `Session.shell` is `Workspace.shell` with the session fixed,
    // so an option added to one has to reach the other. Checked at
    // compile time: a TS interface has no fields to enumerate at
    // runtime, so an option the `Session` type does not carry fails to
    // index, and one whose type drifted fails to assign. The bound
    // field is the one exception -- the object *is* the session, so
    // naming one per call would be a second, contradictory source.
    // The python twin hand-copies nine parameters and is pinned by
    // tests/workspace/workspace/test_handle_signature.py.
    type Forwarded = { [K in keyof SessionExecuteOptions]: ExecuteOptions[K] }
    const parity: Forwarded = {} as SessionExecuteOptions
    expect(parity).toBeDefined()
    expectTypeOf<SessionExecuteOptions>().toEqualTypeOf<Omit<ExecuteOptions, 'sessionId'>>()
  })
})

describe('session tools', () => {
  async function plain(): Promise<Workspace> {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    open.push(ws)
    await ws.shell('echo one > /a.txt')
    return ws
  }

  it('has one table per session that every caller shares', async () => {
    const ws = await plain()
    const agent = await ws.session('agent')
    const other = await ws.session('other')
    expect(agent.tools).toBe(new Session(ws, 'agent').tools)
    expect(ws.tools).toBe(new Session(ws, null).tools)
    await agent.tools.call('read', { path: '/a.txt' })
    const written = await new Session(ws, 'agent').tools.call('write', {
      path: '/a.txt',
      content: 'two\n',
    })
    const refused = await other.tools.call('write', { path: '/a.txt', content: 'three\n' })
    expect(written.isError).toBeUndefined()
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toContain('read all of it')
  })

  it('drops a closed session table', async () => {
    const ws = await plain()
    const agent = await ws.session('agent')
    await agent.tools.call('read', { path: '/a.txt' })
    await ws.closeSession('agent')
    const again = await ws.session('agent')
    const refused = await again.tools.call('write', { path: '/a.txt', content: 'two\n' })
    expect(refused.isError).toBe(true)
  })

  it('follows the default session a snapshot restores', async () => {
    const source = await plain()
    const state = await toStateDict(source)
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    open.push(ws)
    const tools = ws.tools
    await applyStateDict(ws, state)
    const read = await tools.call('read', { path: '/a.txt' })
    expect(ws.defaultSessionId).toBe(source.defaultSessionId)
    expect(read.isError, read.content[0]?.text).toBeUndefined()
    expect(ws.tools).toBe(tools)
  })

  it('keeps an explicit default id on its session after a restore', async () => {
    const source = await plain()
    const state = await toStateDict(source)
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    open.push(ws)
    const pinned = new Session(ws, ws.defaultSessionId).tools
    expect(pinned).not.toBe(ws.tools)
    await applyStateDict(ws, state)
    await expect(pinned.call('read', { path: '/a.txt' })).rejects.toThrow('unknown session')
  })

  it('starts a restored default with no read history', async () => {
    const source = await plain()
    const state = await toStateDict(source)
    const ws = await plain()
    const tools = ws.tools
    await tools.call('read', { path: '/a.txt' })
    await applyStateDict(ws, state)
    const refused = await tools.call('write', { path: '/a.txt', content: 'two\n' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toContain('read all of it')
  })

  it('shares one read history between the default tables', async () => {
    const ws = await plain()
    await ws.tools.call('read', { path: '/a.txt' })
    const written = await new Session(ws, ws.defaultSessionId).tools.call('write', {
      path: '/a.txt',
      content: 'two\n',
    })
    expect(written.isError, written.content[0]?.text).toBeUndefined()
  })

  it('starts a restored session with no read history', async () => {
    const source = await plain()
    await source.session('agent')
    const state = await toStateDict(source)
    const ws = await plain()
    const agent = (await ws.session('agent')).tools
    await agent.call('read', { path: '/a.txt' })
    await applyStateDict(ws, state)
    const refused = await agent.call('write', { path: '/a.txt', content: 'two\n' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toContain('read all of it')
  })

  it('counts a read in flight during a restore for no one', async () => {
    const source = await plain()
    const state = await toStateDict(source)
    const ws = await plain()
    const reads = await ws.sessionReads(null)
    const real = reads.read.bind(reads)
    let entered!: () => void
    let release!: () => void
    const inside = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    reads.read = async (path: string) => {
      const data = await real(path)
      entered()
      await gate
      return data
    }
    const pending = ws.tools.call('read', { path: '/a.txt' })
    await inside
    await applyStateDict(ws, state)
    release()
    await pending
    const refused = await ws.tools.call('write', { path: '/a.txt', content: 'two\n' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toContain('read all of it')
  })
})

// Pinned by tests/workspace/workspace/test_workspace.py too: the workspace id,
// the default session id, then each mount, on both hosts.
const SEED_5_IDS = [
  '00000000-0000-709b-a78b-37e02557f3ef',
  '00000000-0000-709c-a45f-a2ddcbf27499',
  '00000000-0000-709d-8a25-2d58fd25f996',
  '00000000-0000-709e-b168-26af1c8ce177',
]

async function replay(seed: number): Promise<string[]> {
  const ws = new Workspace(
    {
      '/data': [new RAMVFS(), MountMode.WRITE] as const,
      '/more': [new RAMVFS(), MountMode.WRITE] as const,
    },
    { mode: MountMode.WRITE, ids: new SeededIdSource(seed) },
  )
  open.push(ws)
  await ws.shell('seq 1 20 > /data/n.txt && seq 30 40 > /more/m.txt')
  const seen = [ws.workspaceId, ws.defaultSessionId, ws.mount('/data').mountId]
  for (const line of [
    'mktemp -u /data/t.XXXXXX',
    'shuf -n 3 /data/n.txt',
    'shuf -i 1-9',
    'cat /data/n.txt | shuf -n 2',
    'shuf -n 4 /more/m.txt',
  ]) {
    const result = await ws.shell(line)
    expect(result.exitCode, line).toBe(0)
    seen.push(stdoutStr(result))
  }
  for (const event of await ws.observer.events()) seen.push(String(event.process))
  const copy = await ws.copy()
  open.push(copy)
  seen.push(copy.mount('/data').mountId)
  return seen
}

describe('the workspace id source', () => {
  it('replays every id and draw of a run', async () => {
    const refuse = (): never => {
      throw new Error('a seeded workspace drew from the system')
    }
    const uuid = vi.spyOn(SystemIdSource.prototype, 'uuid7').mockImplementation(refuse)
    const word = vi.spyOn(SystemIdSource.prototype, 'randomU32').mockImplementation(refuse)
    try {
      const first = await replay(5)
      expect(await replay(5)).toEqual(first)
      expect(await replay(6)).not.toEqual(first)
    } finally {
      uuid.mockRestore()
      word.mockRestore()
    }
  })

  it('mints its ids in a fixed order', () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { ids: new SeededIdSource(5) })
    open.push(ws)
    expect([
      ws.workspaceId,
      ws.defaultSessionId,
      ws.mount('/dev').mountId,
      ws.mount('/data').mountId,
    ]).toEqual(SEED_5_IDS)
  })

  it('stamps default ids from the workspace clock', () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { clock: new ManualClock(1_700_000_000) })
    open.push(ws)
    for (const value of [ws.workspaceId, ws.defaultSessionId, ws.mount('/data').mountId]) {
      expect(parseInt(value.slice(0, 8) + value.slice(9, 13), 16)).toBe(1_700_000_000_000)
    }
  })

  it('creates sessions on the workspace clock', () => {
    const clock = new ManualClock(1_000)
    const ws = new Workspace({ '/data': new RAMVFS() }, { clock })
    open.push(ws)
    clock.advance(5)
    const created = ws.createSession('other')
    expect(ws.getSession(ws.defaultSessionId).createdAt).toBe(1_000)
    expect(created.createdAt).toBe(1_005)
  })

  it('lets a given id outrank the source', () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { workspaceId: 'ws-given', sessionId: 'sess-given', ids: new SeededIdSource(5) },
    )
    open.push(ws)
    expect(ws.workspaceId).toBe('ws-given')
    expect(ws.defaultSessionId).toBe('sess-given')
  })
})

describe('a manual clock workspace', () => {
  it('keeps one time domain in its history', async () => {
    const clock = new ManualClock(1_000_000)
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE, clock })
    try {
      await ws.shell('echo hi > /data/a.txt')
      clock.advance(5)
      await ws.shell('cat /data/a.txt')
      clock.advance(5)
      await ws.vfs.read('/data/a.txt')
      await ws.shell('history -c')
      await new Promise((resolve) => setTimeout(resolve, 0))
      const events = await ws.observer.events()
      const types = new Set(events.map((e) => e.type))
      for (const type of ['vfs', 'command', 'clear']) expect(types.has(type)).toBe(true)
      expect(new Set(events.map((e) => e.timestamp))).toEqual(
        new Set([1_000_000_000, 1_000_005_000, 1_000_010_000]),
      )
      expect(
        new Set(ws.vfs.records.map((r) => `${String(r.timestamp)}:${String(r.durationMs)}`)),
      ).toEqual(new Set(['1000000000:0', '1000005000:0', '1000010000:0']))
    } finally {
      await ws.close()
    }
  })
})

/**
 * A sandbox runtime on machine `stopbox:b1` that records the processes it
 * was asked to stop, holds those of the pids in `holds`, and does not answer
 * for pid 6.
 */
class StoppedBox extends MachineHandle {
  static override readonly provider = 'stopbox'
  readonly stopped: [string, number][] = []

  constructor(private readonly holds: readonly number[]) {
    super('b1')
  }

  connect(): Promise<void> {
    return Promise.resolve()
  }

  protected execArgv(): Promise<RunResult> {
    return Promise.resolve({ stdout: new Uint8Array(), stderr: null, exitCode: 0 })
  }

  override stop(tag: string, signum: number): Promise<boolean> {
    this.stopped.push([tag, signum])
    const pid = Number(tag.slice(tag.lastIndexOf(':') + 1))
    return Promise.resolve(pid !== 6 && this.holds.includes(pid))
  }
}

function boxProcess(pid: number, machine = 'stopbox:b1'): Record<string, unknown> {
  return { pid, session: 's', machine, runtime: 'x' }
}

// A lapsed workspace's programs are stopped by whatever reaches them here: a
// machine's by the machine its record names, reached once it held it, by its
// process's tag. One the machine does not hold, one whose machine did not
// answer, one on a machine this workspace does not declare and a host program
// of another host are out of reach.
it('stops the programs its machines reach', async () => {
  const box = new StoppedBox([2])
  const ws = new Workspace({}, { machines: { b1: box } })
  try {
    const wid = ws.processTable.workspaceId
    const stop = (record: Record<string, unknown>, signum: number) =>
      ws.machineTable.stop(ws.processTable, record, signum)
    expect(await stop(boxProcess(2), 15)).toBe(true)
    expect(await stop(boxProcess(3), 15)).toBe(false)
    expect(await stop(boxProcess(6), 15)).toBe(false)
    expect(await stop(boxProcess(4, 'other:b2'), 15)).toBe(false)
    const host = {
      ...boxProcess(5, 'host:elsewhere'),
      machine_pid: { pid: 41, started: 1, exited: null },
    }
    expect(await stop(host, 15)).toBe(false)
    expect(box.stopped).toEqual([
      [`${wid}:2`, 15],
      [`${wid}:3`, 15],
      [`${wid}:6`, 15],
    ])
  } finally {
    await ws.close()
  }
})

// A workspace stops what a lapsed instance left as it starts, before anything
// lists processes.
it('stops a lapsed instance as it starts', async () => {
  const box = new StoppedBox([2])
  const ws = new Workspace({}, { machines: { b1: box } })
  try {
    const store = new RAMExecutionStore(30)
    ws.jobTable.store = store
    await store.publish('dead', { '2': boxProcess(2) })
    await ws.shell('true')
    await vi.waitFor(async () => {
      expect('dead' in (await store.processes())).toBe(false)
    })
    expect(box.stopped).toEqual([[`${ws.processTable.workspaceId}:2`, 15]])
  } finally {
    await ws.close()
  }
})

// Each line, job and process a workspace runs has a record it lists, by
// session, state or line, and finds by id.
it('lists its lines, jobs and processes', async () => {
  const ws = new Workspace({ '/data': new RAMVFS() })
  try {
    const pid = Number(stdoutStr(await ws.shell('sleep 30 & echo $!')))
    const [line] = await ws.lines()
    expect([line?.command, line?.state, line?.exit]).toEqual(['sleep 30 & echo $!', 'exited', 0])
    if (line === undefined) throw new Error('no line')
    expect(await ws.line(line.id)).toEqual(line)
    expect(await ws.lines({ sessionId: 'other' })).toEqual([])
    expect(await ws.lines({ state: 'running' })).toEqual([])
    const [job] = await ws.jobs({ state: 'running' })
    expect([job?.command, job?.line?.value]).toEqual(['sleep 30', line.id.value])
    if (job === undefined) throw new Error('no job')
    expect(await ws.job(job.id)).toEqual(job)
    const running = await ws.processes({ state: 'running' })
    expect(running.map((p) => p.id.pid)).toEqual([pid])
    const [held] = running
    if (held === undefined) throw new Error('no process')
    expect(await ws.process(held.id)).toEqual(held)
    expect((await ws.processes({ lineId: line.id })).map((p) => p.id.pid)).toContain(pid)
    await ws.shell('kill %1; wait')
    const ended = await ws.process(held.id)
    expect([ended?.state, ended?.signal]).toEqual(['exited', 15])
  } finally {
    await ws.close()
  }
})

// A daemon that does not hold the workspace's lease lists the lines, jobs and
// processes the holder runs, as their store keeps them.
it('lists what the holder runs from another daemon', async () => {
  const store = new RAMWorkspaceStateStore()
  const [a, b] = [0, 1].map(
    () =>
      new Workspace(
        { '/m': [new RAMVFS(), MountMode.WRITE] },
        { mode: MountMode.WRITE, workspaceId: 'shared', sessionId: 's', store },
      ),
  )
  if (a === undefined || b === undefined) throw new Error('no workspace')
  try {
    const pid = Number(stdoutStr(await a.shell('sleep 30 & echo $!', { sessionId: 's' })))
    const [line] = await b.lines()
    expect([line?.command, line?.state, line?.exit]).toEqual(['sleep 30 & echo $!', 'exited', 0])
    if (line === undefined) throw new Error('no line')
    expect(await b.line(line.id)).toEqual(line)
    const [running] = await b.processes({ state: 'running' })
    expect([running?.id.pid, running?.line?.value]).toEqual([pid, line.id.value])
    if (running === undefined) throw new Error('no process')
    expect(await b.process(running.id)).toEqual(running)
    const [job] = await b.jobs()
    expect([job?.command, job?.state]).toEqual(['sleep 30', 'running'])
    await a.shell('kill %1; wait', { sessionId: 's' })
    const ended = await b.process(running.id)
    expect([ended?.state, ended?.signal]).toEqual(['exited', 15])
  } finally {
    await a.close()
    await b.close()
  }
})

// A daemon that does not hold the lease stops listing the jobs of a session
// the holder closed.
it('drops the jobs of a session the holder closed', async () => {
  const store = new RAMWorkspaceStateStore()
  const [a, b] = [0, 1].map(
    () =>
      new Workspace(
        { '/m': [new RAMVFS(), MountMode.WRITE] },
        { mode: MountMode.WRITE, workspaceId: 'shared', sessionId: 's', store },
      ),
  )
  if (a === undefined || b === undefined) throw new Error('no workspace')
  try {
    a.createSession('t')
    await a.shell('sleep 30 &', { sessionId: 't' })
    expect((await b.jobs()).map((job) => job.sessionId)).toEqual(['t'])
    await a.closeSession('t')
    expect(await b.jobs()).toEqual([])
  } finally {
    await a.close()
    await b.close()
  }
})

// The line and process records a daemon left running when it went end as
// hung up once the next one takes the workspace's lease, and a process id of
// another workspace names none here.
it('ends the records a lost daemon left running as hung up', async () => {
  const store = new RAMWorkspaceStateStore()
  const ws = new Workspace({ '/m': new RAMVFS() }, { workspaceId: 'w', store })
  try {
    const left: Process = {
      id: new ProcessId('w', 99),
      sessionId: 's',
      line: new LineId('lost'),
      parent: null,
      group: 99,
      command: 'sleep 30',
      cwd: PathSpec.fromStrPath('/'),
      machine: new MachineName('host', 'gone'),
      startedAt: 1,
      runtime: null,
      machinePid: null,
      state: 'running',
      endedAt: null,
      exit: null,
      signal: null,
      error: null,
      ancestors: [],
    }
    ws.jobTable.store.note(left)
    ws.jobTable.store.note({
      id: new LineId('lost'),
      sessionId: 's',
      command: 'sleep 30 &',
      startedAt: 1,
      state: 'running',
      endedAt: null,
      exit: null,
      signal: null,
      error: null,
    })
    await ws.shell('true')
    const process = await ws.process(left.id)
    expect([process?.state, process?.exit, process?.signal]).toEqual(['exited', 129, 1])
    const line = await ws.line(new LineId('lost'))
    expect([line?.state, line?.exit]).toEqual(['exited', 129])
    expect(await ws.process(new ProcessId('other', 99))).toBeNull()
  } finally {
    await ws.close()
  }
})

// A line queued behind another of its session is listed as waiting, and
// ends stopped when it is aborted before it starts.
it('lists a queued line as waiting until it is aborted', async () => {
  const ws = new Workspace({ '/data': new RAMVFS() })
  const stopFirst = new AbortController()
  const first = ws.shell('sleep 30', { signal: stopFirst.signal }).catch(() => undefined)
  try {
    await vi.waitFor(async () => {
      expect(await ws.lines({ state: 'running' })).toHaveLength(1)
    })
    const stopSecond = new AbortController()
    const second = ws.shell('echo next', { signal: stopSecond.signal })
    await vi.waitFor(async () => {
      expect(await ws.lines({ state: 'waiting' })).toHaveLength(1)
    })
    const [waiting] = await ws.lines({ state: 'waiting' })
    expect(waiting?.command).toBe('echo next')
    stopSecond.abort()
    await expect(second).rejects.toThrow()
    if (waiting === undefined) throw new Error('no line')
    const ended = await ws.line(waiting.id)
    expect([ended?.state, ended?.signal]).toEqual(['exited', 2])
  } finally {
    stopFirst.abort()
    await first
    await ws.close()
  }
})
