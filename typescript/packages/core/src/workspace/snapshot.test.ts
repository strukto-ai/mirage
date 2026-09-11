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

import { ruleToJSON } from './session/serialize.ts'
import { setCwd } from './session/shell_dirs.ts'
import { seedVar } from './session/state.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { registerCliSpec, unregisterCliSpec } from '../commands/cli/specs.ts'
import { CLISpec, type CLIInvocation } from '../commands/cli/types.ts'
import { IOResult } from '../io/types.ts'
import { PolicyDenied } from '../policy/errors.ts'
import type { Policy } from '../policy/index.ts'
import type { Action, SessionContext } from '../policy/types.ts'
import { secretStr } from '../resource/secrets.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource, type RAMResourceState } from '../resource/ram/ram.ts'
import { REDACTED_SECRET, resourceStateRequiresOverride } from '../resource/secrets.ts'
import { type JobResult } from '../shell/job_table/index.ts'
import { createShellParser, type ShellParser } from '../shell/parse/index.ts'
import { ConsistencyPolicy, MountMode } from '../types.ts'
import { VERSION } from '../version.ts'
import { parseSessionProfile, profileFromJSON, type SessionProfile } from '../policy/profile.ts'
import type { WorkspaceOptions } from './workspace/types.ts'
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
    const jobs2 = ws2.jobTable.listJobs('worker')
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

/** Refuse env writes to GATE_* names, the deployment's rule. */
class DenyGate implements Policy {
  preSession(ctx: SessionContext): Action | null {
    if (ctx.plane === 'env' && ctx.key.startsWith('GATE_')) {
      return { kind: 'deny', reason: 'GATE_* refused by policy' }
    }
    return null
  }
}

function gatedWorkspace(prefix = '/data', sessionId?: string): Workspace {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  ops.registerResource(ram)
  return new Workspace(
    { [prefix]: ram },
    {
      mode: MountMode.WRITE,
      ops,
      shellParser: parser,
      policies: [new DenyGate()],
      ...(sessionId !== undefined ? { sessionId } : {}),
    },
  )
}

describe('applyStateDict and the deployment', () => {
  // The restore used to seed `session.vars` directly, past the gate a live
  // `export GATE_X=1` clears (#1017); a snapshot is the one env input the
  // deployment did not author, so this is the door where the rule matters.
  it('a restored variable clears the session gate', async () => {
    const source = buildWorkspace()
    await source.execute('export GATE_X=1')
    const state = await toStateDict(source)
    await source.close()
    const target = gatedWorkspace()
    await expect(applyStateDict(target, state)).rejects.toBeInstanceOf(PolicyDenied)
    expect(Object.hasOwn(target.env, 'GATE_X')).toBe(false)
    await target.close()
  })

  it('a restore the gate allows lands every variable', async () => {
    const source = buildWorkspace()
    await source.execute('export PUBLIC_X=1')
    const state = await toStateDict(source)
    await source.close()
    const target = gatedWorkspace()
    await applyStateDict(target, state)
    expect(target.env.PUBLIC_X).toBe('1')
    await target.close()
  })

  // A snapshot holding several sessions used to land each one as its
  // table cleared the gate, so a refusal on a later session left the
  // earlier ones overwritten, the default identity adopted and every
  // mount's state loaded: a workspace matching no snapshot, and one a
  // close would then persist. Every table is vetted before anything lands.
  it('a refused session table leaves the workspace untouched', async () => {
    const ram = new RAMResource()
    const ops = new OpsRegistry()
    ops.registerResource(ram)
    const source = new Workspace(
      { '/data': ram },
      { mode: MountMode.WRITE, ops, shellParser: parser, sessionId: 'src' },
    )
    expect((await source.execute('echo restored > /data/f.txt')).exitCode).toBe(0)
    expect((await source.execute('export PUBLIC_A=1')).exitCode).toBe(0)
    source.createSession('s2')
    expect((await source.execute('export GATE_X=1', { sessionId: 's2' })).exitCode).toBe(0)
    const state = await toStateDict(source)
    await source.close()
    const target = gatedWorkspace('/data', 'tgt')
    expect((await target.execute('export KEEP=1')).exitCode).toBe(0)
    await expect(applyStateDict(target, state)).rejects.toBeInstanceOf(PolicyDenied)
    expect(Object.hasOwn(target.env, 'PUBLIC_A')).toBe(false)
    expect(target.env.KEEP).toBe('1')
    expect(target.listSessions().map((s) => s.sessionId)).toEqual(['tgt'])
    expect((await target.execute('test -e /data/f.txt')).exitCode).toBe(1)
    await target.close()
  })

  // The env template is vetted with the tables, so a refused template
  // lands no session either.
  it('a refused env template lands no session', async () => {
    const ram = new RAMResource()
    const ops = new OpsRegistry()
    ops.registerResource(ram)
    const source = new Workspace(
      { '/data': ram },
      { mode: MountMode.WRITE, ops, shellParser: parser, env: { GATE_X: '1' } },
    )
    expect((await source.execute('unset GATE_X; export PUBLIC_A=1')).exitCode).toBe(0)
    const state = await toStateDict(source)
    await source.close()
    const target = gatedWorkspace()
    await expect(applyStateDict(target, state)).rejects.toBeInstanceOf(PolicyDenied)
    expect(Object.hasOwn(target.env, 'PUBLIC_A')).toBe(false)
    expect(Object.hasOwn(target.env, 'GATE_X')).toBe(false)
    await target.close()
  })

  // A session the restore had to create was a bare one, under no
  // profile, while its table had cleared the gate under the default
  // profile's policy (`scriptOf` for an id the manager does not know);
  // the created session now runs under that profile, so what the gate
  // judged is what lands, and a restored session no longer wakes
  // unrestricted.
  it('a session the restore creates runs under the default profile', async () => {
    const source = buildWorkspace()
    expect((await source.execute('echo kept > /data/f.txt')).exitCode).toBe(0)
    source.createSession('s2')
    expect((await source.execute('export PUBLIC_A=1', { sessionId: 's2' })).exitCode).toBe(0)
    const state = await toStateDict(source)
    await source.close()
    const ram = new RAMResource()
    const ops = new OpsRegistry()
    ops.registerResource(ram)
    const target = new Workspace(
      { '/data': ram },
      {
        mode: MountMode.WRITE,
        ops,
        shellParser: parser,
        profiles: {
          default: { commands: { deny: [{ reason: 'no removals', commands: ['rm'] }] } },
        },
      },
    )
    await applyStateDict(target, state)
    const compiled = target.sessionManager.defaultProfile
    expect(compiled).not.toBeNull()
    const restored = target.getSession('s2')
    expect(restored.profile).toBe('default')
    expect(restored.commands).toBe(compiled?.commands)
    expect(restored.script).toBe(compiled?.script)
    expect(target.sessionManager.scriptOf('s2')).toBe(compiled?.script)
    expect(restored.env.PUBLIC_A).toBe('1')
    const refused = await target.execute('rm /data/f.txt', { sessionId: 's2' })
    expect(refused.exitCode).toBe(126)
    expect(new TextDecoder().decode(refused.stderr)).toContain('rm: Permission denied')
    expect((await target.execute('test -e /data/f.txt')).exitCode).toBe(0)
    await target.close()
  })

  // A snapshot prefix the workspace does not mount was skipped in silence
  // (#1019); the state is still not restored (never into an ancestor
  // mount), but the load now says so.
  it('a snapshot mount with no matching prefix is reported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const source = buildWorkspace()
      const state = await toStateDict(source)
      await source.close()
      const other = new RAMResource()
      const ops = new OpsRegistry()
      ops.registerResource(other)
      const target = new Workspace(
        { '/elsewhere': other },
        { mode: MountMode.WRITE, ops, shellParser: parser },
      )
      await applyStateDict(target, state)
      await target.close()
      const messages = warn.mock.calls.map((c) => String(c[0]))
      expect(messages.some((m) => m.includes('/data') && m.includes('not restored'))).toBe(true)
      expect(messages.some((m) => m.includes('/elsewhere'))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  // A mount that asks to be handed back live (`needs_override`, a
  // redacted credential) skipped the prefix check along with its
  // loadState, so a renamed remote mount, the case the report exists
  // for, stayed silent while Python reported it. The loadState skip is
  // gone too, and for the same reason it was wrong in the first place:
  // a snapshot's content is the snapshot's, and the resources that ask
  // to be handed back live are exactly the ones behind a credential --
  // redis and disk carry their bytes in that state, so skipping them
  // dropped every one while python restored them. A cred-only resource
  // (the S3 family) implements loadState as a no-op, which is what made
  // the skip look harmless.
  it('a live-only snapshot mount with no matching prefix is reported too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const data = new RAMResource()
      const keep = new RAMResource()
      const ops = new OpsRegistry()
      ops.registerResource(data)
      const source = new Workspace(
        { '/data': data, '/keep': keep },
        { mode: MountMode.WRITE, ops, shellParser: parser },
      )
      const state = await toStateDict(source)
      await source.close()
      for (const m of state.mounts) m.resource_state = { ...m.resource_state, needs_override: true }
      const live = new RAMResource()
      const liveOps = new OpsRegistry()
      liveOps.registerResource(live)
      const loadState = vi.spyOn(live, 'loadState')
      const target = new Workspace(
        { '/keep': live },
        { mode: MountMode.WRITE, ops: liveOps, shellParser: parser },
      )
      await applyStateDict(target, state)
      await target.close()
      const messages = warn.mock.calls.map((c) => String(c[0]))
      expect(messages.some((m) => m.includes('/data') && m.includes('not restored'))).toBe(true)
      expect(messages.some((m) => m.includes('/keep'))).toBe(false)
      expect(loadState).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

const RESTRICTED = {
  env: { SLACK_TOKEN: 'xoxb-secret' },
  vars: { hide: ['SLACK_TOKEN'] },
  commands: { deny: ['rm'], ask: [{ reason: 'creates files', commands: ['touch'] }] },
}

const LOCKED = {
  commands: { allow: ['echo', 'cat', 'rm', 'ls', 'test'], deny: ['rm'] },
  policy: {
    script: new ScriptSource('export function preCommand() {\n  return null\n}\n', 'js'),
    runtime: 'quickjs',
  },
}

function profiled(
  profiles: Record<string, unknown>,
  options: Partial<WorkspaceOptions> = {},
  mode: MountMode = MountMode.WRITE,
): Workspace {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  ops.registerResource(ram)
  const parsed: Record<string, SessionProfile> = Object.fromEntries(
    Object.entries(profiles).map(([name, doc]) => [name, parseSessionProfile(doc)]),
  )
  return new Workspace(
    { '/data': [ram, mode] },
    { mode: MountMode.WRITE, ops, shellParser: parser, profiles: parsed, ...options },
  )
}

const loadOptions = (): WorkspaceOptions => ({
  mode: MountMode.WRITE,
  ops: new OpsRegistry(),
  shellParser: parser,
})

async function line(ws: Workspace, command: string, sessionId: string) {
  const result = await ws.execute(command, { sessionId })
  return {
    exit: result.exitCode,
    out: new TextDecoder().decode(result.stdout),
    err: new TextDecoder().decode(result.stderr),
  }
}

describe('the document rides the state and the restore never widens', () => {
  // A session created under a named profile came back under the target's
  // default: the snapshot carried no document, so `Workspace.load` had
  // nothing to narrow it under, and the restore copied cwd, vars and
  // modes off the table and dropped the rest. The state now carries the
  // document and the restore lands the whole table under the profile of
  // its name.
  it('a session under a named profile survives fromState', async () => {
    const source = profiled({ default: {}, restricted: RESTRICTED })
    source.createSession('agent', {
      profile: 'restricted',
      permissions: parseSessionProfile({ commands: { deny: ['mv'] } }),
    })
    expect((await line(source, 'touch /data/made', 'agent')).exit).toBe(126)
    const pending = source.decisions.pending('agent')
    expect(pending).toHaveLength(1)
    const state = await toStateDict(source)
    await source.close()
    expect(state.profile).toBeNull()
    expect(profileFromJSON(state.profiles?.restricted ?? {})).toEqual(
      parseSessionProfile(RESTRICTED),
    )
    const target = await Workspace.fromState(state, loadOptions())
    const restored = target.getSession('agent')
    expect(restored.profile).toBe('restricted')
    expect(restored.hiddenVars).not.toBeNull()
    expect(await line(target, 'echo tok=[$SLACK_TOKEN]', 'agent')).toEqual({
      exit: 0,
      out: 'tok=[]\n',
      err: '',
    })
    const refused = await line(target, 'rm -f /data/x', 'agent')
    expect(refused.exit).toBe(126)
    expect(refused.err).toContain('rm: Permission denied')
    expect((await line(target, 'mv /data/a /data/b', 'agent')).exit).toBe(126)
    expect((await line(target, 'export SLACK_TOKEN=evil', 'agent')).exit).not.toBe(0)
    expect(target.decisions.pending('agent').map((d) => d.id)).toEqual(pending.map((d) => d.id))
    // The record spells a rule with every key, the compiled document only
    // the stated ones; the ledger compares them structurally.
    expect(target.decisions.pending('agent').map((d) => ruleToJSON(d.rule))).toEqual(
      pending.map((d) => ruleToJSON(d.rule)),
    )
    await target.close()
  })

  // A restored table is a fact about the source session, never a grant:
  // a wider cap and a wider allow list than the target's document states
  // land as the target's, and what the table adds on top is kept.
  it('a restored table never widens the target document', async () => {
    const source = profiled({ default: { commands: { allow: ['cat', 'echo', 'touch', 'ls'] } } })
    source.createSession('agent', { mounts: { '/data': 'write' } })
    expect((await line(source, 'touch /data/made', 'agent')).exit).toBe(0)
    const state = await toStateDict(source)
    await source.close()
    const target = profiled({
      default: {
        mounts: { '/data': 'r' },
        commands: { allow: ['echo', 'ls', 'rm'], deny: ['rm'] },
      },
    })
    await applyStateDict(target, state)
    const restored = target.getSession('agent')
    expect(restored.mountModes).toEqual(new Map([['/data', MountMode.READ]]))
    expect(new Set(restored.commands?.allow ?? [])).toEqual(new Set(['echo', 'ls']))
    expect((await line(target, 'echo ok', 'agent')).exit).toBe(0)
    expect((await line(target, 'touch /data/x', 'agent')).exit).toBe(127)
    expect((await line(target, 'rm /data/made', 'agent')).exit).not.toBe(0)
    const listed = await line(target, 'ls /data', 'agent')
    expect(listed.exit).toBe(0)
    expect(listed.out).toContain('made')
    await target.close()
  })

  // The other direction: a table narrower than the target's document
  // lands with its own hides, denies and answers, under a target that
  // states nothing at all (its `default` name resolves to the target
  // default).
  it("a table's own narrowing lands under a permissive target", async () => {
    const source = profiled({ default: RESTRICTED })
    expect((await source.execute('echo kept > /data/f.txt')).exitCode).toBe(0)
    source.createSession('agent')
    expect((await line(source, 'touch /data/made', 'agent')).exit).toBe(126)
    const state = await toStateDict(source)
    await source.close()
    const target = buildWorkspace()
    await applyStateDict(target, state)
    for (const sid of ['agent', target.defaultSessionId]) {
      expect(await line(target, 'echo tok=[$SLACK_TOKEN]', sid)).toEqual({
        exit: 0,
        out: 'tok=[]\n',
        err: '',
      })
      expect((await line(target, 'rm /data/f.txt', sid)).exit).toBe(126)
    }
    expect((await target.execute('test -e /data/f.txt')).exitCode).toBe(0)
    expect(target.decisions.pending('agent')).toHaveLength(1)
    // Nothing the target document never said arrives as a program.
    expect(target.getSession('agent').profile).toBeNull()
    expect(target.getSession('agent').script).toBeNull()
    await target.close()
  })

  // A name the target does not define is refused with the PolicyError an
  // unknown profile gets everywhere, before a mount or a session has
  // moved.
  it('an unknown profile name refuses the load before it lands', async () => {
    const source = profiled({ restricted: RESTRICTED }, { sessionId: 'src' })
    expect((await source.execute('echo restored > /data/f.txt')).exitCode).toBe(0)
    source.createSession('agent', { profile: 'restricted' })
    const state = await toStateDict(source)
    await source.close()
    const target = profiled({}, { sessionId: 'tgt' })
    expect((await target.execute('export KEEP=1')).exitCode).toBe(0)
    await expect(applyStateDict(target, state)).rejects.toThrow(/unknown profile "restricted"/)
    expect(target.env.KEEP).toBe('1')
    expect(target.listSessions().map((s) => s.sessionId)).toEqual(['tgt'])
    expect((await target.execute('test -e /data/f.txt')).exitCode).toBe(1)
    // The gate created a candidate for the table and dropped it, so the
    // id is free again.
    expect(target.createSession('agent').sessionId).toBe('agent')
    await target.close()
    // The loader's own document has the same rule: one that omits the
    // snapshot's default profile fails at construction.
    await expect(
      Workspace.fromState(
        { ...state, profile: 'restricted' },
        { ...loadOptions(), profiles: { default: parseSessionProfile({}) } },
      ),
    ).rejects.toThrow(/unknown profile "restricted"/)
  })

  // The loader's document outranks the snapshot's, the way the document
  // outranks a stored record at hydration.
  it("a loader-supplied document wins over the snapshot's", async () => {
    const source = profiled({ restricted: RESTRICTED })
    source.createSession('agent', { profile: 'restricted' })
    const state = await toStateDict(source)
    await source.close()
    const target = await Workspace.fromState(state, {
      ...loadOptions(),
      profiles: { restricted: parseSessionProfile({ commands: { deny: ['touch'] } }) },
    })
    const restored = target.getSession('agent')
    expect(restored.profile).toBe('restricted')
    // The table's hides and rules still land (never wider), the loader's
    // rule beside them.
    expect(restored.hiddenVars).not.toBeNull()
    expect((await line(target, 'touch /data/x', 'agent')).exit).toBe(126)
    expect((await line(target, 'rm -f /data/x', 'agent')).exit).toBe(126)
    expect(target.createSession('fresh', { profile: 'restricted' }).hiddenVars).toBeNull()
    await target.close()
  })

  // Landing a workspace's own state on itself changes nothing, which a
  // checkout that hands live tables back through the restore relies on.
  it("re-applying a workspace's own state is a no-op", async () => {
    const ws = profiled(
      {
        default: {
          mounts: {
            '/data': {
              mode: 'rw',
              paths: { hide: ['/data/sealed', '*.pem'], show: { '/data/sealed/public': 'r' } },
              commands: { ask: ['git push'] },
            },
          },
          vars: { hide: ['AWS_*'] },
          commands: { allow: ['ls', 'cat', 'echo', 'git *', 'rm'], deny: ['rm'] },
        },
        restricted: RESTRICTED,
      },
      {},
      MountMode.EXEC,
    )
    ws.createSession('agent', {
      profile: 'restricted',
      permissions: parseSessionProfile({ paths: { hide: ['/data/.env'] } }),
    })
    expect((await ws.execute('echo a > /data/a.txt')).exitCode).toBe(0)
    expect((await line(ws, 'touch /data/b', 'agent')).exit).toBe(126)
    const before = ws.listSessions().map((s) => s.toJSON())
    const compiled = ws.sessionManager.defaultProfile
    expect(compiled).not.toBeNull()
    await applyStateDict(ws, await toStateDict(ws))
    expect(ws.listSessions().map((s) => s.toJSON())).toEqual(before)
    const dflt = ws.getSession(ws.defaultSessionId)
    expect(dflt.commands).toBe(compiled?.commands)
    expect(dflt.hiddenPaths).toBe(compiled?.hiddenPaths)
    expect(dflt.shownPaths).toBe(compiled?.shownPaths)
    expect(dflt.hiddenVars).toBe(compiled?.hiddenVars)
    expect(dflt.hideReasons).toBe(compiled?.hideReasons)
    await ws.close()
  })

  // The consistency knob is the workspace's; every mount used to record
  // the mount() default and the loader restored LAZY regardless.
  it('the consistency knob round-trips', async () => {
    const source = profiled({}, { consistency: ConsistencyPolicy.ALWAYS })
    const state = await toStateDict(source)
    await source.close()
    expect(state.consistency).toBe('always')
    expect(state.mounts.every((m) => m.consistency === 'always')).toBe(true)
    expect(buildMountArgs(state).consistency).toBe(ConsistencyPolicy.ALWAYS)
    const target = await Workspace.fromState(state, loadOptions())
    expect(target.registry.getConsistency()).toBe(ConsistencyPolicy.ALWAYS)
    await target.close()
    const { consistency: _dropped, ...older } = state
    void _dropped
    expect(buildMountArgs(older as typeof state).consistency).toBe(ConsistencyPolicy.LAZY)
  })

  // A coded policy is named, never carried: the loader registers it, and
  // a name nothing answers to is reported rather than silently dropped.
  it('a recorded policy class the target lacks is reported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const source = profiled({}, { policies: [new DenyGate()] })
      const state = await toStateDict(source)
      await source.close()
      expect(state.policies).toEqual(['DenyGate'])
      const target = await Workspace.fromState(state, loadOptions())
      await target.close()
      expect(warn.mock.calls.some((c) => String(c[0]).includes('DenyGate'))).toBe(true)
      warn.mockClear()
      const supplied = await Workspace.fromState(state, {
        ...loadOptions(),
        policies: [new DenyGate()],
      })
      await supplied.close()
      expect(warn.mock.calls.some((c) => String(c[0]).includes('policy class'))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  // Content behind a credential: the restore skipped loadState for
  // every mount whose recorded config carried a redaction marker,
  // which is exactly what a content resource behind a credential has,
  // so a redis or disk mount's bytes were dropped on this host while
  // python restored them. Found by the cross-language snapshot
  // battery (integ/snapshot), where TypeScript could not read back a
  // redis mount either arm had written.
  it('loads the state of a mount whose config is redacted', async () => {
    const loaded: RAMResourceState[] = []
    class CredentialedRAM extends RAMResource {
      override getState(): RAMResourceState {
        // What a store behind a credential records: its content, and a
        // config whose secret is a marker rather than the secret. The
        // config rides beside the declared fields, as every
        // credentialed resource's state does.
        return { ...super.getState(), config: { url: REDACTED_SECRET } } as RAMResourceState
      }

      override loadState(state: RAMResourceState): void {
        loaded.push(state)
        super.loadState(state)
      }
    }
    const source = new CredentialedRAM()
    const ops = new OpsRegistry()
    ops.registerResource(source)
    const ws = new Workspace(
      { '/data': source },
      { mode: MountMode.WRITE, ops, shellParser: parser },
    )
    expect((await ws.execute('echo kept > /data/f.txt')).exitCode).toBe(0)
    const state = await toStateDict(ws)
    await ws.close()
    const mount = state.mounts.find((m) => m.prefix.replace(/\/$/, '') === '/data')
    expect(mount).toBeDefined()
    expect(resourceStateRequiresOverride(mount?.resource_state)).toBe(true)
    // A redacted config cannot be rebuilt, so the loader is handed a
    // live resource -- and its state has to land in it.
    const target = new CredentialedRAM()
    const restored = await Workspace.fromState(state, loadOptions(), { '/data': target })
    expect(loaded).toHaveLength(1)
    expect(new TextDecoder().decode(await restored.fs.readFile('/data/f.txt'))).toBe('kept\n')
    await restored.close()
  })

  // The gate created and narrowed the sessions it had to make, but left
  // the default session and every live one on whatever profile they
  // already ran under, so the target's document of the name a table
  // carries never governed the restored session: `narrowRestored` takes
  // no program and no new restriction off a table, and nothing else
  // applied the document's.
  it('a stricter loader profile governs the restored default session', async () => {
    const source = profiled({ crew: { commands: { deny: ['rm'] } } })
    expect((await source.execute('echo kept > /data/f.txt')).exitCode).toBe(0)
    await source.setSessionProfile(source.defaultSessionId, 'crew')
    const state = await toStateDict(source)
    await source.close()
    const target = await Workspace.fromState(state, {
      ...loadOptions(),
      profiles: { crew: parseSessionProfile({ commands: { deny: ['rm', 'cat'] } }) },
    })
    const restored = target.getSession(target.defaultSessionId)
    expect(restored.profile).toBe('crew')
    const sid = target.defaultSessionId
    expect((await line(target, 'rm /data/f.txt', sid)).exit).toBe(126)
    expect((await line(target, 'cat /data/f.txt', sid)).exit).toBe(126)
    expect((await line(target, 'ls /data', sid)).exit).toBe(0)
    await target.close()
  })

  // The other half of the same rule: a checkout adds the version's
  // restrictions to a live session and lifts none of the live ones, and
  // the program the host installed with setSessionProfile stays.
  it("a checkout never lifts a live session's program", async () => {
    const source = profiled({})
    expect((await source.execute('echo kept > /data/f.txt')).exitCode).toBe(0)
    const state = await toStateDict(source)
    await source.close()
    const target = profiled({ locked: LOCKED })
    await target.setSessionProfile(target.defaultSessionId, 'locked')
    const program = target.getSession(target.defaultSessionId).script
    expect(program).not.toBeNull()
    await applyStateDict(target, state, { replaceCache: true })
    const live = target.getSession(target.defaultSessionId)
    expect(live.script).toBe(program)
    expect(live.profile).toBe('locked')
    expect((await line(target, 'rm /data/f.txt', target.defaultSessionId)).exit).toBe(126)
    await target.close()
  })

  // A refusal after the profiles have been joined onto the live
  // sessions puts them back: the workspace is the one the snapshot
  // never touched.
  it('a refused table puts a joined live session back', async () => {
    const source = profiled({ crew: { commands: { deny: ['rm'] } } })
    await source.setSessionProfile(source.defaultSessionId, 'crew')
    expect((await source.execute('export SEALED=1')).exitCode).toBe(0)
    const state = await toStateDict(source)
    await source.close()
    const refuseSealed: Policy = {
      preSession: (ctx) =>
        ctx.key === 'SEALED' ? { kind: 'deny', reason: 'sealed is refused' } : null,
    }
    const target = profiled({ crew: { commands: { deny: ['rm'] } } }, { policies: [refuseSealed] })
    const before = target.getSession(target.defaultSessionId).toJSON()
    await expect(applyStateDict(target, state)).rejects.toThrow()
    expect(target.getSession(target.defaultSessionId).toJSON()).toEqual(before)
    await target.close()
  })

  // A policy hook reads its program off the manager by session id, and
  // the manager cannot answer for the snapshot's default id until
  // `adoptDefault` re-keys the live default onto it. So a checkout
  // whose recorded default id differs from the live one gated that
  // table under the target's default program instead of the one the
  // join had just installed, and a `preSession` rule the named profile
  // carries never saw the restored variables.
  it('gates a remapped default table under its landing id', async () => {
    // The rule keys on the session id the gate names, which is the one
    // thing the fix changes: a hook is handed `sessionId` and, in
    // `ScriptPolicy`'s case, resolves its program from it. The live
    // default is where the table lands; the recorded `src` is an id the
    // manager cannot answer for until `adoptDefault` re-keys it.
    const gated: string[] = []
    const sealed: Policy = {
      preSession: (ctx) => {
        gated.push(ctx.sessionId)
        return ctx.sessionId === 'tgt' && ctx.key === 'SEALED'
          ? { kind: 'deny', reason: 'sealed is refused' }
          : null
      },
    }
    const source = profiled({}, { sessionId: 'src' })
    expect((await source.execute('export SEALED=1')).exitCode).toBe(0)
    const state = await toStateDict(source)
    await source.close()
    expect(state.default_session_id).toBe('src')
    const target = profiled({}, { sessionId: 'tgt', policies: [sealed] })
    await expect(applyStateDict(target, state)).rejects.toThrow(/sealed is refused/)
    expect(gated).toContain('tgt')
    expect(gated).not.toContain('src')
    // Refused before anything landed: the live default keeps its id and
    // the variable never arrived.
    expect(target.defaultSessionId).toBe('tgt')
    expect(target.getSession('tgt').vars.SEALED).toBeUndefined()
    await target.close()
  })
})
