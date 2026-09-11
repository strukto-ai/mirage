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

import { setCwd } from './session/shell_dirs.ts'
import { seedVar } from './session/state.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { registerCliSpec, unregisterCliSpec } from '../commands/cli/specs.ts'
import { CLISpec, type CLIInvocation } from '../commands/cli/types.ts'
import { IOResult } from '../io/types.ts'
import { secretStr } from '../resource/secrets.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { type JobResult } from '../shell/job_table/index.ts'
import { createShellParser, type ShellParser } from '../shell/parse/index.ts'
import { MountMode } from '../types.ts'
import { VERSION } from '../version.ts'
import { splitManifestAndBlobs } from './snapshot/manifest.ts'
import {
  applyStateDict,
  buildMountArgs,
  restoresAsFreshRAM,
  savedResourceBuild,
  toStateDict,
} from './snapshot/state.ts'
import type { MountSnapshot } from './snapshot/types.ts'
import { ScriptSource } from '../runtime/routing/types.ts'
import { ExecutionNode } from './types.ts'
import { Workspace } from './workspace/workspace.ts'

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
    // Through setCwd, so $PWD tracks the move: assigning `cwd` directly
    // leaves PWD stale, which the old wholesale env replacement hid.
    setCwd(worker, '/data')
    seedVar(worker, 'ROLE', 'bg')
    ws.jobTable.submit({
      command: 'sleep 0',
      run: () => Promise.resolve([new IOResult(), new ExecutionNode()] as JobResult),
      abort: new AbortController(),
      cwd: '/data',
      sessionId: 'worker',
    })
    await ws.jobTable.waitAll()

    const state = await toStateDict(ws)
    const workerSnap = state.sessions.find((s) => s.session_id === 'worker')
    expect(workerSnap?.cwd).toBe('/data')
    expect(workerSnap?.env).toEqual({ ROLE: 'bg', PWD: '/data' })
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
    expect(w2.env).toEqual({ ROLE: 'bg', PWD: '/data' })
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

describe('cli registry snapshot', () => {
  const cliEcho = (inv: CLIInvocation) =>
    [
      new TextEncoder().encode(`tok=${(inv.config as { token: string }).token}\n`),
      new IOResult(),
    ] as [Uint8Array, IOResult]

  function makeCliSpec(): CLISpec {
    return new CLISpec({
      name: 'snapcli',
      configModel: z.object({ token: secretStr(), channel: z.string().default('general') }),
      subcommands: [new CLISpec({ name: 'run', fn: cliEcho })],
    })
  }

  it('captures with schema-declared secrets redacted and restores via override', async () => {
    const spec = makeCliSpec()
    registerCliSpec(spec)
    try {
      const ws = buildWorkspace()
      ws.registerCli('snapcli', spec, { token: 'sek', channel: 'eng' })
      const state = await toStateDict(ws)
      expect(state.clis).toEqual([
        {
          name: 'snapcli',
          spec: 'snapcli',
          config: { token: '<REDACTED>', channel: 'eng' },
        },
      ])

      await expect(Workspace.fromState(state, { shellParser: parser })).rejects.toThrow(
        /clis= must include/,
      )

      const ws2 = await Workspace.fromState(
        state,
        { shellParser: parser },
        {},
        { snapcli: { token: 'sek2', channel: 'eng' } },
      )
      const r = await ws2.execute('snapcli run')
      expect(r.exitCode).toBe(0)
      expect(r.stdoutText).toBe('tok=sek2\n')
      await ws.close()
      await ws2.close()
    } finally {
      unregisterCliSpec('snapcli')
    }
  })

  it('copy shares live cli secrets and the live spec', async () => {
    // The spec is deliberately NOT in the global registry: copy() must
    // carry the live CLISpec like a live resource, not resolve by name.
    const spec = makeCliSpec()
    const ws = buildWorkspace()
    ws.registerCli('snapcli', spec, { token: 'sek' })
    const clone = await ws.copy()
    const r = await clone.execute('snapcli run')
    expect(r.exitCode).toBe(0)
    expect(r.stdoutText).toBe('tok=sek\n')
    await ws.close()
    await clone.close()
  })

  it('persists a script install so load can rebuild the spec', async () => {
    // A script install resolves under no registry name, so the embedded
    // program rides in the state and load rebuilds the spec from it.
    const ws = buildWorkspace()
    ws.registerCli(
      'pager',
      new CLISpec({ name: 'pager', script: new ScriptSource("print('hi')") }),
      { width: 80 },
    )
    const state = await toStateDict(ws)
    const entry = state.clis?.[0]
    expect(entry?.spec).toBe('pager')
    expect(entry?.script?.source).toBe("print('hi')")
    expect(entry?.script?.language).toBe('python')
    expect(entry?.script?.module).toBe(false)
    // No configModel means nothing declares a secret, so the mapping is
    // captured verbatim rather than guessed at.
    expect(entry?.config).toEqual({ width: 80 })

    const restored = await Workspace.fromState(state, { shellParser: parser })
    const install = restored.clis().get('pager')
    expect(install?.spec.script?.source).toBe("print('hi')")
    expect(install?.spec.runtime).toBeNull()
    await ws.close()
    await restored.close()
  })

  it('carries the runtime pin and the module bit through a snapshot', async () => {
    const ws = buildWorkspace()
    ws.registerCli(
      'pager',
      new CLISpec({
        name: 'pager',
        script: new ScriptSource('export const x = 1', 'js', true),
        runtime: 'quickjs',
      }),
      null,
    )
    const state = await toStateDict(ws)
    expect(state.clis?.[0]?.runtime).toBe('quickjs')
    expect(state.clis?.[0]?.script?.module).toBe(true)
    const restored = await Workspace.fromState(state, { shellParser: parser })
    const install = restored.clis().get('pager')
    expect(install?.spec.runtime).toBe('quickjs')
    expect(install?.spec.script?.module).toBe(true)
    expect(install?.spec.script?.language).toBe('js')
    await ws.close()
    await restored.close()
  })

  it('the tar manifest carries installed clis', async () => {
    // The manifest is an explicit key allowlist, and omitting clis
    // dropped every install from a tar snapshot.
    const ws = buildWorkspace()
    ws.registerCli(
      'pager',
      new CLISpec({ name: 'pager', script: new ScriptSource("print('hi')") }),
      null,
    )
    const [manifest] = splitManifestAndBlobs(
      (await toStateDict(ws)) as unknown as Record<string, unknown>,
    )
    const clis = manifest.clis as { name: string; script?: { source: string } }[]
    expect(clis).toHaveLength(1)
    expect(clis[0]?.name).toBe('pager')
    expect(clis[0]?.script?.source).toBe("print('hi')")
    await ws.close()
  })
})

describe('savedResourceBuild', () => {
  const known = (name: string): boolean => ['ram', 'disk', 'redis', 'seeded'].includes(name)

  function saved(type: string, ref: string | null, config?: unknown): MountSnapshot {
    return {
      index: 0,
      prefix: '/s/',
      mode: MountMode.WRITE,
      consistency: 'lazy',
      resource_class: type,
      resource_ref: ref,
      resource_state: config === undefined ? { type } : { type, config },
    }
  }

  it('rebuilds through the recorded ref before a type the registry also knows', () => {
    // A subclass inherits `kind`, so an alias registered over a builtin
    // reports the builtin's type; the ref is the door it came through.
    expect(savedResourceBuild(saved('redis', 'seeded'), known)?.name).toBe('seeded')
    expect(savedResourceBuild(saved('ram', 'seeded'), known)?.name).toBe('seeded')
    expect(restoresAsFreshRAM(saved('ram', 'seeded'))).toBe(false)
  })

  it('falls back to the type only for a mount constructed in code', () => {
    expect(savedResourceBuild(saved('redis', null), known)?.name).toBe('redis')
    // A v3 snapshot from before the key carries no ref at all.
    const preKey: Partial<MountSnapshot> = { ...saved('redis', null) }
    delete preKey.resource_ref
    expect(savedResourceBuild(preKey as MountSnapshot, known)?.name).toBe('redis')
  })

  it('does not guess from the type when the recorded ref cannot be resolved', () => {
    expect(savedResourceBuild(saved('redis', 'ghost'), known)).toBeNull()
    expect(savedResourceBuild(saved('ram', 'ghost'), known)).toBeNull()
    expect(restoresAsFreshRAM(saved('ram', 'ghost'))).toBe(false)
  })

  it('hands a code reference to the registry as recorded', () => {
    expect(savedResourceBuild(saved('redis', '/tmp/seeded.mjs:SeededRedis'), known)?.name).toBe(
      '/tmp/seeded.mjs:SeededRedis',
    )
  })

  it('leaves disk, and ram declared by name or in code, to buildMountArgs', () => {
    const local = [
      saved('ram', null),
      saved('ram', 'ram'),
      saved('disk', null),
      saved('disk', 'disk'),
      saved('disk', 'mydisk'),
    ]
    for (const entry of local) {
      expect(restoresAsFreshRAM(entry)).toBe(true)
      expect(savedResourceBuild(entry, known)).toBeNull()
    }
  })

  it('passes an object config through and drops any other shape', () => {
    expect(savedResourceBuild(saved('redis', null, { url: 'redis://x' }), known)?.config).toEqual({
      url: 'redis://x',
    })
    expect(savedResourceBuild(saved('redis', null, 'nope'), known)?.config).toEqual({})
  })

  it('buildMountArgs refuses a mount nobody could build rather than substituting RAM', async () => {
    const ws = buildWorkspace()
    const state = await toStateDict(ws)
    await ws.close()
    const [mount] = state.mounts
    if (mount === undefined) throw new Error('snapshot recorded no mounts')
    // As saved by a process holding an alias this one never registered.
    mount.resource_ref = 'ghost'
    expect(() => buildMountArgs(state)).toThrow(/resources= must include overrides for: \/data/)
    // The same mount handed back live loads.
    expect(() => buildMountArgs(state, { [mount.prefix]: new RAMResource() })).not.toThrow()
  })
})
