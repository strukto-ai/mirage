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
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IOResult } from '../io/types.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { type JobTaskResult } from '../shell/job_table.ts'
import { createShellParser, type ShellParser } from '../shell/parse.ts'
import { MountMode } from '../types.ts'
import { VERSION } from '../version.ts'
import { applyStateDict, toStateDict } from './snapshot/state.ts'
import { ExecutionNode } from './types.ts'
import { Workspace } from './workspace.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser
let tempDir: string

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
  tempDir = mkdtempSync(join(tmpdir(), 'mirage-snapshot-'))
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function buildWorkspace(): Workspace {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  ops.registerResource(ram)
  return new Workspace({ '/data': ram }, { mode: MountMode.WRITE, ops, shellParser: parser })
}

describe('toStateDict / applyStateDict', () => {
  it('roundtrips file content via snapshot + restore', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo "hello" | tee /data/x.txt')
    const state = await toStateDict(ws)
    const ws2 = buildWorkspace()
    await applyStateDict(ws2, state)
    const r = await ws2.execute('cat /data/x.txt')
    expect(new TextDecoder().decode(r.stdout)).toBe('hello\n')
    await ws.close()
    await ws2.close()
  })

  it('restores history entries through snapshot + load', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo "one"')
    await ws.execute('echo "two"')
    expect((await ws.history()).length).toBe(2)
    const path = join(tempDir, 'history.json')
    await ws.snapshot(path)
    const loaded = await Workspace.load(path, {
      mode: MountMode.WRITE,
      ops: new OpsRegistry(),
      shellParser: parser,
    })
    const entries = await loaded.history()
    expect(entries.length).toBe(2)
    expect(entries[0]?.command).toBe('echo "one"')
    expect(entries[1]?.command).toBe('echo "two"')
    await ws.close()
    await loaded.close()
  })

  it('restores cache entries even when every mount has redacted config', async () => {
    const ram = new RAMResource()
    ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
    const ops = new OpsRegistry()
    ops.registerResource(ram)
    const ws = new Workspace({ '/data': ram }, { mode: MountMode.WRITE, ops, shellParser: parser })
    await ws.execute('echo "cached" | tee /data/x.txt > /dev/null')
    await ws.execute('cat /data/x.txt > /dev/null')
    const state = await toStateDict(ws)
    expect(state.cache.entries.length).toBeGreaterThan(0)
    for (const m of state.mounts) {
      Object.assign(m.resource_state, { config: { token: '<REDACTED>' } })
    }

    const overrides: Record<string, RAMResource> = {}
    for (const m of state.mounts) overrides[m.prefix] = new RAMResource()
    const restored = await Workspace.fromState(
      state,
      { mode: MountMode.WRITE, ops: new OpsRegistry(), shellParser: parser },
      overrides,
    )
    const cacheKeys = (
      restored as unknown as { cache: { snapshotEntries(): { key: string }[] } }
    ).cache
      .snapshotEntries()
      .map((e) => e.key)
    expect(cacheKeys.length).toBe(state.cache.entries.length)
    await ws.close()
    await restored.close()
  })

  it('skips the .bash_history/ view mount from the snapshot', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo "hi" | tee /data/x.txt')
    const state = await toStateDict(ws)
    for (const m of state.mounts) {
      expect(m.prefix).not.toBe('/.bash_history/')
    }
    await ws.close()
  })
})

describe('Workspace.snapshot / Workspace.load', () => {
  it('writes a snapshot file and loads it back', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo "persistent" | tee /data/x.txt')
    const path = join(tempDir, 'snap.json')
    const size = await ws.snapshot(path)
    expect(size).toBeGreaterThan(0)

    const loaded = await Workspace.load(path, {
      mode: MountMode.WRITE,
      ops: new OpsRegistry(),
      shellParser: parser,
    })
    const r = await loaded.execute('cat /data/x.txt')
    expect(new TextDecoder().decode(r.stdout)).toBe('persistent\n')
    await ws.close()
    await loaded.close()
  })

  it('rejects snapshots with an older unsupported format version', async () => {
    const ws = buildWorkspace()
    const state = await toStateDict(ws)
    state.version = 1
    await expect(
      Workspace.fromState(state, {
        mode: MountMode.WRITE,
        ops: new OpsRegistry(),
        shellParser: parser,
      }),
    ).rejects.toThrow(/snapshot format/)
    await ws.close()
  })
})

describe('Workspace.copy', () => {
  it('creates an independent workspace with the same content', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo "original" | tee /data/x.txt')
    const cp = await ws.copy()
    await cp.execute('echo "mutated" | tee /data/x.txt')
    const rOrig = await ws.execute('cat /data/x.txt')
    const rCopy = await cp.execute('cat /data/x.txt')
    expect(new TextDecoder().decode(rOrig.stdout)).toBe('original\n')
    expect(new TextDecoder().decode(rCopy.stdout)).toBe('mutated\n')
    await ws.close()
    await cp.close()
  })
})

// Port of tests/workspace/test_snapshot.py::test_ram_round_trip_filenames_with_spaces.
// Verifies snapshot encoding preserves non-ASCII + whitespace filenames.
describe('Workspace.snapshot / load — filenames with spaces and unicode', () => {
  it('roundtrips RAM filenames containing spaces and unicode chars', async () => {
    const src = buildWorkspace()
    const srcMount = src.mount('/data/')
    if (srcMount === null) throw new Error('/data/ mount missing')
    const srcRam = srcMount.resource as RAMResource
    const ENC = new TextEncoder()
    srcRam.store.files.set('/my file.txt', ENC.encode('with spaces'))
    srcRam.store.files.set('/dir with space/data.txt', ENC.encode('nested with space'))
    srcRam.store.files.set('/数据.txt', ENC.encode('你好'))
    srcRam.store.dirs.add('/dir with space')

    const path = join(tempDir, 'spaces.json')
    await src.snapshot(path)
    const loaded = await Workspace.load(path, {
      mode: MountMode.WRITE,
      ops: new OpsRegistry(),
      shellParser: parser,
    })
    const dstMount = loaded.mount('/data/')
    if (dstMount === null) throw new Error('/data/ mount missing')
    const dstRam = dstMount.resource as RAMResource
    const DEC = new TextDecoder()
    expect(DEC.decode(dstRam.store.files.get('/my file.txt'))).toBe('with spaces')
    expect(DEC.decode(dstRam.store.files.get('/dir with space/data.txt'))).toBe('nested with space')
    expect(DEC.decode(dstRam.store.files.get('/数据.txt'))).toBe('你好')
    await src.close()
    await loaded.close()
  })
})

describe('Workspace.snapshot / load — per-mount mode preservation', () => {
  it('preserves per-mount modes through save → load', async () => {
    const ws = new Workspace(
      { '/': new RAMResource(), '/ro': [new RAMResource(), MountMode.READ] as const },
      { mode: MountMode.WRITE },
    )
    const tmp = join(mkdtempSync(join(tmpdir(), 'snap-')), 'ws.tar')
    await ws.snapshot(tmp)
    const loaded = await Workspace.load(tmp)
    const mounts = loaded.registry.allMounts()
    const roMount = mounts.find((m) => m.prefix === '/ro/')
    expect(roMount?.mode).toBe(MountMode.READ)
    const rootMount = mounts.find((m) => m.prefix === '/')
    expect(rootMount?.mode).toBe(MountMode.WRITE)
  })

  it('load accepts an in-memory tar buffer', async () => {
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    const tmp = join(mkdtempSync(join(tmpdir(), 'snap-')), 'ws.tar')
    await ws.snapshot(tmp)
    const buf = readFileSync(tmp)
    const restored = await Workspace.load(buf)
    expect(restored.registry.allMounts().length).toBeGreaterThan(0)
  })
})

// Mirrors Python apply_state_dict: sessions (cwd/env) and finished jobs
// survive the toStateDict → fromState round trip, not just mounts/cache/history.
describe('Workspace.fromState — sessions and finished jobs', () => {
  it('restores default + non-default session cwd/env and a completed job', async () => {
    const ws = buildWorkspace()
    await ws.execute('cd /data')
    await ws.execute('export FOO=bar')
    const worker = ws.sessionManager.create('worker')
    worker.cwd = '/data'
    worker.env = { ROLE: 'bg' }
    ws.jobTable.submit({
      command: 'sleep 0',
      task: Promise.resolve([null, new IOResult(), new ExecutionNode()] as JobTaskResult),
      abort: new AbortController(),
      cwd: '/data',
      sessionId: 'worker',
    })
    await ws.jobTable.waitAll()

    const state = await toStateDict(ws)
    const workerSnap = state.sessions.find((s) => s.session_id === 'worker')
    expect(workerSnap?.cwd).toBe('/data')
    expect(workerSnap?.env).toEqual({ ROLE: 'bg' })
    expect(state.jobs.length).toBe(1)
    expect(state.jobs[0]?.command).toBe('sleep 0')
    expect(state.jobs[0]?.status).toBe('completed')

    const ws2 = await Workspace.fromState(state, {
      mode: MountMode.WRITE,
      ops: new OpsRegistry(),
      shellParser: parser,
    })
    const def = ws2.sessionManager.get(ws2.sessionManager.defaultId)
    expect(def.cwd).toBe('/data')
    expect(def.env.FOO).toBe('bar')
    const w2 = ws2.sessionManager.get('worker')
    expect(w2.cwd).toBe('/data')
    expect(w2.env).toEqual({ ROLE: 'bg' })
    const jobs2 = ws2.jobTable.listJobs()
    expect(jobs2.length).toBe(1)
    expect(jobs2[0]?.command).toBe('sleep 0')
    expect(jobs2[0]?.status).toBe('completed')
    expect(jobs2[0]?.cwd).toBe('/data')
    expect(jobs2[0]?.sessionId).toBe('worker')

    await ws.close()
    await ws2.close()
  })

  it('preserves a non-default default session id and agent id', async () => {
    const ram = new RAMResource()
    const ops = new OpsRegistry()
    ops.registerResource(ram)
    const ws = new Workspace(
      { '/data': ram },
      { mode: MountMode.WRITE, ops, shellParser: parser, sessionId: 'main', agentId: 'agent-7' },
    )
    await ws.execute('cd /data')
    await ws.execute('export FOO=bar')

    const state = await toStateDict(ws)
    expect(state.default_session_id).toBe('main')
    expect(state.default_agent_id).toBe('agent-7')

    const ws2 = await Workspace.fromState(state, {
      mode: MountMode.WRITE,
      ops: new OpsRegistry(),
      shellParser: parser,
    })
    expect(ws2.sessionManager.defaultId).toBe('main')
    const def = ws2.sessionManager.get('main')
    expect(def.cwd).toBe('/data')
    expect(def.env.FOO).toBe('bar')
    expect(ws2.agentId).toBe('agent-7')

    await ws.close()
    await ws2.close()
  })

  it('records the real package version in mirage_version', async () => {
    const ws = buildWorkspace()
    const state = await toStateDict(ws)
    expect(state.mirage_version).toBe(VERSION)
    expect(state.mirage_version).not.toBe('unknown')
    expect(state.mirage_version).toMatch(/\d+\.\d+\.\d+/)
    await ws.close()
  })

  it('aggregates every redacted mount missing an override into one error', async () => {
    const ops = new OpsRegistry()
    const ramA = new RAMResource()
    const ramB = new RAMResource()
    ops.registerResource(ramA)
    ops.registerResource(ramB)
    const ws = new Workspace(
      { '/a': ramA, '/b': ramB },
      { mode: MountMode.WRITE, ops, shellParser: parser },
    )
    const state = await toStateDict(ws)
    for (const m of state.mounts) {
      Object.assign(m.resource_state, { config: { token: '<REDACTED>' } })
    }
    let err: Error | null = null
    try {
      await Workspace.fromState(state, {
        mode: MountMode.WRITE,
        ops: new OpsRegistry(),
        shellParser: parser,
      })
    } catch (e) {
      err = e as Error
    }
    expect(err).not.toBeNull()
    expect(err?.message).toContain('must include overrides for')
    expect(err?.message).toContain('/a/')
    expect(err?.message).toContain('/b/')
    await ws.close()
  })
})
