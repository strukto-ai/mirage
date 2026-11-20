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
import { JobTable } from '../../execution/job/index.ts'
import { LineHandle } from '../../execution/line/handle.ts'
import { LineId } from '../../execution/types.ts'
import { IOResult } from '../../io/types.ts'
import type { HandOff } from '../../policy/types.ts'
import { JobConsole } from '../../shell/console/index.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import type { ExecuteFn } from '../expand/types.ts'
import { Namespace } from '../mount/namespace/namespace.ts'
import { MountRegistry } from '../mount/registry.ts'
import type { ExecuteNodeOpts } from './command/types.ts'
import { type ExecuteNodeDeps, withHandOff, withOpts } from './deps.ts'

type EntryOpts = Parameters<ExecuteFn>[1]

function recordingEntry(seen: EntryOpts[]): ExecuteFn {
  return (_cmd, opts) => {
    seen.push(opts)
    return Promise.resolve(new IOResult())
  }
}

function buildDeps(executeFn: ExecuteFn): ExecuteNodeDeps {
  const registry = new MountRegistry({ '/ram': new RAMVFS() }, MountMode.WRITE)
  return {
    dispatch: () => {
      throw new Error('dispatch should not have been called')
    },
    registry,
    namespace: new Namespace(registry, (p) => Promise.resolve(registry.resolve(p))),
    jobTable: new JobTable(),
    executeFn,
  }
}

function handOff(): HandOff {
  return { claimed: [], parent: null, origin: null }
}

describe('withOpts', () => {
  it('returns the walker value itself when no options are given', () => {
    const base = buildDeps(recordingEntry([]))
    expect(withOpts(base)).toBe(base)
    expect(withOpts(base, undefined)).toBe(base)
  })

  it('copies the walker value for an empty options object', () => {
    const base = buildDeps(recordingEntry([]))
    const next = withOpts(base, {})
    expect(next).not.toBe(base)
    expect(next).toEqual(base)
  })

  it('overrides sink, signal and line handle when given', () => {
    const base = buildDeps(recordingEntry([]))
    const sink = new JobConsole()
    const signal = new AbortController().signal
    const lineHandle = new LineHandle(new LineId('line'), 's', 'c')
    const next = withOpts(base, { sink, signal, lineHandle })
    expect(next.sink).toBe(sink)
    expect(next.signal).toBe(signal)
    expect(next.lineHandle).toBe(lineHandle)
    expect(next.executeFn).toBe(base.executeFn)
    expect(next.jobTable).toBe(base.jobTable)
    expect(base.sink).toBeUndefined()
  })

  it('keeps the walker fields an undefined option names', () => {
    const base = {
      ...buildDeps(recordingEntry([])),
      sink: new JobConsole(),
      signal: new AbortController().signal,
      lineHandle: new LineHandle(new LineId('line'), 's', 'c'),
    }
    const unset = {
      sink: undefined,
      signal: undefined,
      lineHandle: undefined,
      jobTable: undefined,
      handed: undefined,
    } as unknown as ExecuteNodeOpts
    const next = withOpts(base, unset)
    expect(next).toEqual(base)
    expect(next.sink).toBe(base.sink)
    expect(next.signal).toBe(base.signal)
    expect(next.lineHandle).toBe(base.lineHandle)
    expect(next.executeFn).toBe(base.executeFn)
    expect('handed' in next).toBe(false)
  })

  it('leaves endsShell and ownDiagnostics to the walker', () => {
    const base = buildDeps(recordingEntry([]))
    const next = withOpts(base, { endsShell: true, ownDiagnostics: false })
    expect(next).toEqual(base)
    expect('endsShell' in next).toBe(false)
    expect('ownDiagnostics' in next).toBe(false)
  })

  it('binds a given job table into the entry point', async () => {
    const seen: EntryOpts[] = []
    const base = buildDeps(recordingEntry(seen))
    const jobTable = new JobTable()
    const next = withOpts(base, { jobTable })
    expect(next.jobTable).toBe(jobTable)
    expect(base.jobTable).not.toBe(jobTable)
    await next.executeFn('true', { sessionId: 's' })
    expect(seen[0]?.jobTable).toBe(jobTable)
    expect(seen[0]?.sessionId).toBe('s')
  })

  it('lets a caller job table win over the bound one', async () => {
    const seen: EntryOpts[] = []
    const next = withOpts(buildDeps(recordingEntry(seen)), { jobTable: new JobTable() })
    const own = new JobTable()
    await next.executeFn('true', { sessionId: 's', jobTable: own })
    expect(seen[0]?.jobTable).toBe(own)
  })

  it('runs a given hand-off through withHandOff', async () => {
    const seen: EntryOpts[] = []
    const base = buildDeps(recordingEntry(seen))
    const handed = handOff()
    const jobTable = new JobTable()
    const next = withOpts(base, { handed, jobTable })
    expect(next.handed).toBe(handed)
    await next.executeFn('true', { sessionId: 's' })
    expect(seen[0]?.handed).toBe(handed)
    expect(seen[0]?.jobTable).toBe(jobTable)
  })
})

describe('withHandOff', () => {
  it('sets the hand-off and keeps every other field', () => {
    const base = { ...buildDeps(recordingEntry([])), sink: new JobConsole() }
    const handed = handOff()
    const next = withHandOff(base, handed)
    expect(next).not.toBe(base)
    expect(next.handed).toBe(handed)
    expect(next.sink).toBe(base.sink)
    expect(next.jobTable).toBe(base.jobTable)
    expect(next.registry).toBe(base.registry)
    expect(next.executeFn).not.toBe(base.executeFn)
    expect(base.handed).toBeUndefined()
  })

  it('rebinds the entry point to the hand-off', async () => {
    const seen: EntryOpts[] = []
    const handed = handOff()
    const next = withHandOff(buildDeps(recordingEntry(seen)), handed)
    await next.executeFn('true', { sessionId: 's' })
    expect(seen[0]?.handed).toBe(handed)
    expect(seen[0]?.sessionId).toBe('s')
  })

  it('lets a caller hand-off win over the bound one', async () => {
    const seen: EntryOpts[] = []
    const next = withHandOff(buildDeps(recordingEntry(seen)), handOff())
    const own = handOff()
    await next.executeFn('true', { sessionId: 's', handed: own })
    expect(seen[0]?.handed).toBe(own)
  })

  it('replaces an earlier hand-off', async () => {
    const seen: EntryOpts[] = []
    const first = withHandOff(buildDeps(recordingEntry(seen)), handOff())
    const second = handOff()
    const next = withHandOff(first, second)
    expect(next.handed).toBe(second)
    await next.executeFn('true', { sessionId: 's' })
    expect(seen[0]?.handed).toBe(second)
  })
})
