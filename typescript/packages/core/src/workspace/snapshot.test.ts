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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { registerCliSpec, unregisterCliSpec } from '../commands/cli/specs.ts'
import { CLISpec, type CLIInvocation } from '../commands/cli/types.ts'
import { IOResult } from '../io/types.ts'
import { PolicyDenied } from '../policy/errors.ts'
import type { Policy } from '../policy/index.ts'
import type { Action, SessionContext } from '../policy/types.ts'
import { secretStr } from '../vfs/secrets.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { type JobResult } from '../shell/job_table/index.ts'
import { createShellParser, type ShellParser } from '../shell/parse/index.ts'
import { DEFAULT_READ_TTL, MountMode, ReadPolicy } from '../types.ts'
import { VERSION } from '../version.ts'
import { splitManifestAndBlobs } from './snapshot/manifest.ts'
import {
  applyStateDict,
  buildMountArgs,
  restoresAsFreshRAM,
  savedVfsBuild,
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
  const ram = new RAMVFS()
  const ops = new OpsRegistry()
  ops.registerVfs(ram)
  return new Workspace({ '/data': ram }, { mode: MountMode.WRITE, ops, shellParser: parser })
}

describe('toStateDict / applyStateDict', () => {
  it('roundtrips file content via snapshot + restore', async () => {
    const ws = buildWorkspace()
    await ws.shell('echo "hello" | tee /data/x.txt')
    const state = await toStateDict(ws)
    const ws2 = buildWorkspace()
    await applyStateDict(ws2, state)
    const r = await ws2.shell('cat /data/x.txt')
    expect(new TextDecoder().decode(r.stdout)).toBe('hello\n')
    await ws.close()
    await ws2.close()
  })

  it('restores history entries through snapshot + load', async () => {
    const ws = buildWorkspace()
    await ws.shell('echo "one"')
    await ws.shell('echo "two"')
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
    const ram = new RAMVFS()
    ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
    const ops = new OpsRegistry()
    ops.registerVfs(ram)
    const ws = new Workspace({ '/data': ram }, { mode: MountMode.WRITE, ops, shellParser: parser })
    await ws.shell('echo "cached" | tee /data/x.txt > /dev/null')
    await ws.shell('cat /data/x.txt > /dev/null')
    const state = await toStateDict(ws)
    expect(state.cache.entries.length).toBeGreaterThan(0)
    for (const m of state.mounts) {
      Object.assign(m.vfs_state, { config: { token: '<REDACTED>' } })
    }

    const overrides: Record<string, RAMVFS> = {}
    for (const m of state.mounts) overrides[m.prefix] = new RAMVFS()
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
    await ws.shell('echo "hi" | tee /data/x.txt')
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
    await ws.shell('echo "persistent" | tee /data/x.txt')
    const path = join(tempDir, 'snap.json')
    const size = await ws.snapshot(path)
    expect(size).toBeGreaterThan(0)

    const loaded = await Workspace.load(path, {
      mode: MountMode.WRITE,
      ops: new OpsRegistry(),
      shellParser: parser,
    })
    const r = await loaded.shell('cat /data/x.txt')
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
    await ws.shell('echo "original" | tee /data/x.txt')
    const cp = await ws.copy()
    await cp.shell('echo "mutated" | tee /data/x.txt')
    const rOrig = await ws.shell('cat /data/x.txt')
    const rCopy = await cp.shell('cat /data/x.txt')
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
    const srcRam = srcMount.vfs as RAMVFS
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
    const dstRam = dstMount.vfs as RAMVFS
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
      { '/': new RAMVFS(), '/ro': [new RAMVFS(), MountMode.READ] as const },
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
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
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
    await ws.shell('cd /data')
    await ws.shell('export FOO=bar')
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
    const ram = new RAMVFS()
    const ops = new OpsRegistry()
    ops.registerVfs(ram)
    const ws = new Workspace(
      { '/data': ram },
      { mode: MountMode.WRITE, ops, shellParser: parser, sessionId: 'main', agentId: 'agent-7' },
    )
    await ws.shell('cd /data')
    await ws.shell('export FOO=bar')

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
    const ramA = new RAMVFS()
    const ramB = new RAMVFS()
    ops.registerVfs(ramA)
    ops.registerVfs(ramB)
    const ws = new Workspace(
      { '/a': ramA, '/b': ramB },
      { mode: MountMode.WRITE, ops, shellParser: parser },
    )
    const state = await toStateDict(ws)
    for (const m of state.mounts) {
      Object.assign(m.vfs_state, { config: { token: '<REDACTED>' } })
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
      const r = await ws2.shell('snapcli run')
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
    // carry the live CLISpec like a live VFS, not resolve by name.
    const spec = makeCliSpec()
    const ws = buildWorkspace()
    ws.registerCli('snapcli', spec, { token: 'sek' })
    const clone = await ws.copy()
    const r = await clone.shell('snapcli run')
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

describe('savedVfsBuild', () => {
  const known = (name: string): boolean => ['ram', 'disk', 'redis', 'seeded'].includes(name)

  function saved(type: string, ref: string | null, config?: unknown): MountSnapshot {
    return {
      index: 0,
      prefix: '/s/',
      mode: MountMode.WRITE,
      read: 'bounded',
      ttl: 600,
      vfs_class: type,
      vfs_ref: ref,
      vfs_state: config === undefined ? { type } : { type, config },
    }
  }

  it('rebuilds through the recorded ref before a type the registry also knows', () => {
    // A subclass inherits `kind`, so an alias registered over a builtin
    // reports the builtin's type; the ref is the door it came through.
    expect(savedVfsBuild(saved('redis', 'seeded'), known)?.name).toBe('seeded')
    expect(savedVfsBuild(saved('ram', 'seeded'), known)?.name).toBe('seeded')
    expect(restoresAsFreshRAM(saved('ram', 'seeded'))).toBe(false)
  })

  it('falls back to the type only for a mount constructed in code', () => {
    expect(savedVfsBuild(saved('redis', null), known)?.name).toBe('redis')
    // A v3 snapshot from before the key carries no ref at all.
    const preKey: Partial<MountSnapshot> = { ...saved('redis', null) }
    delete preKey.vfs_ref
    expect(savedVfsBuild(preKey as MountSnapshot, known)?.name).toBe('redis')
  })

  it('does not guess from the type when the recorded ref cannot be resolved', () => {
    expect(savedVfsBuild(saved('redis', 'ghost'), known)).toBeNull()
    expect(savedVfsBuild(saved('ram', 'ghost'), known)).toBeNull()
    expect(restoresAsFreshRAM(saved('ram', 'ghost'))).toBe(false)
  })

  it('hands a code reference to the registry as recorded', () => {
    expect(savedVfsBuild(saved('redis', '/tmp/seeded.mjs:SeededRedis'), known)?.name).toBe(
      '/tmp/seeded.mjs:SeededRedis',
    )
  })

  // TypeScript alone stands a mount in with an empty RAMVFS when it has
  // no override and nothing to rebuild from, and such a mount keeps its
  // saved read spec. That is safe only while nothing that could carry
  // `fresh` reaches the stand-in: `ram` and `disk` both report
  // cachesReads false, so the mount-time verdict refused the policy long
  // before the snapshot was written. A backend that became both
  // readRevalidatable and restores-as-fresh-RAM would make a restore
  // that used to succeed throw, so the invariant is pinned rather than
  // left to a comment.
  it('only lets a backend that cannot carry fresh reach the RAM stand-in', () => {
    expect(restoresAsFreshRAM(saved('ram', null))).toBe(true)
    expect(restoresAsFreshRAM(saved('disk', null))).toBe(true)
    expect(new RAMVFS().cachesReads).toBe(false)
    for (const revalidatable of ['s3', 'gridfs']) {
      expect(restoresAsFreshRAM(saved(revalidatable, null))).toBe(false)
    }
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
      expect(savedVfsBuild(entry, known)).toBeNull()
    }
  })

  it('passes an object config through and drops any other shape', () => {
    expect(savedVfsBuild(saved('redis', null, { url: 'redis://x' }), known)?.config).toEqual({
      url: 'redis://x',
    })
    expect(savedVfsBuild(saved('redis', null, 'nope'), known)?.config).toEqual({})
  })

  it('buildMountArgs refuses a mount nobody could build rather than substituting RAM', async () => {
    const ws = buildWorkspace()
    const state = await toStateDict(ws)
    await ws.close()
    const [mount] = state.mounts
    if (mount === undefined) throw new Error('snapshot recorded no mounts')
    // As saved by a process holding an alias this one never registered.
    mount.vfs_ref = 'ghost'
    expect(() => buildMountArgs(state)).toThrow(/mounts= must include overrides for: \/data/)
    // The same mount handed back live loads.
    expect(() => buildMountArgs(state, { [mount.prefix]: new RAMVFS() })).not.toThrow()
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
  const ram = new RAMVFS()
  const ops = new OpsRegistry()
  ops.registerVfs(ram)
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
    await source.shell('export GATE_X=1')
    const state = await toStateDict(source)
    await source.close()
    const target = gatedWorkspace()
    await expect(applyStateDict(target, state)).rejects.toBeInstanceOf(PolicyDenied)
    expect(Object.hasOwn(target.env, 'GATE_X')).toBe(false)
    await target.close()
  })

  it('a restore the gate allows lands every variable', async () => {
    const source = buildWorkspace()
    await source.shell('export PUBLIC_X=1')
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
    const ram = new RAMVFS()
    const ops = new OpsRegistry()
    ops.registerVfs(ram)
    const source = new Workspace(
      { '/data': ram },
      { mode: MountMode.WRITE, ops, shellParser: parser, sessionId: 'src' },
    )
    expect((await source.shell('echo restored > /data/f.txt')).exitCode).toBe(0)
    expect((await source.shell('export PUBLIC_A=1')).exitCode).toBe(0)
    source.createSession('s2')
    expect((await source.shell('export GATE_X=1', { sessionId: 's2' })).exitCode).toBe(0)
    const state = await toStateDict(source)
    await source.close()
    const target = gatedWorkspace('/data', 'tgt')
    expect((await target.shell('export KEEP=1')).exitCode).toBe(0)
    await expect(applyStateDict(target, state)).rejects.toBeInstanceOf(PolicyDenied)
    expect(Object.hasOwn(target.env, 'PUBLIC_A')).toBe(false)
    expect(target.env.KEEP).toBe('1')
    expect(target.listSessions().map((s) => s.sessionId)).toEqual(['tgt'])
    expect((await target.shell('test -e /data/f.txt')).exitCode).toBe(1)
    await target.close()
  })

  // The env template is vetted with the tables, so a refused template
  // lands no session either.
  it('a refused env template lands no session', async () => {
    const ram = new RAMVFS()
    const ops = new OpsRegistry()
    ops.registerVfs(ram)
    const source = new Workspace(
      { '/data': ram },
      { mode: MountMode.WRITE, ops, shellParser: parser, env: { GATE_X: '1' } },
    )
    expect((await source.shell('unset GATE_X; export PUBLIC_A=1')).exitCode).toBe(0)
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
    expect((await source.shell('echo kept > /data/f.txt')).exitCode).toBe(0)
    source.createSession('s2')
    expect((await source.shell('export PUBLIC_A=1', { sessionId: 's2' })).exitCode).toBe(0)
    const state = await toStateDict(source)
    await source.close()
    const ram = new RAMVFS()
    const ops = new OpsRegistry()
    ops.registerVfs(ram)
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
    const refused = await target.shell('rm /data/f.txt', { sessionId: 's2' })
    expect(refused.exitCode).toBe(126)
    expect(new TextDecoder().decode(refused.stderr)).toContain('rm: Permission denied')
    expect((await target.shell('test -e /data/f.txt')).exitCode).toBe(0)
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
      const other = new RAMVFS()
      const ops = new OpsRegistry()
      ops.registerVfs(other)
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
  // for, stayed silent while Python reported it. The skip itself stays:
  // a live mount at the prefix is not loaded from the saved state.
  it('a live-only snapshot mount with no matching prefix is reported too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const data = new RAMVFS()
      const keep = new RAMVFS()
      const ops = new OpsRegistry()
      ops.registerVfs(data)
      const source = new Workspace(
        { '/data': data, '/keep': keep },
        { mode: MountMode.WRITE, ops, shellParser: parser },
      )
      const state = await toStateDict(source)
      await source.close()
      for (const m of state.mounts) m.vfs_state = { ...m.vfs_state, needs_override: true }
      const live = new RAMVFS()
      const liveOps = new OpsRegistry()
      liveOps.registerVfs(live)
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
      expect(loadState).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('the read policy survives a snapshot round trip', () => {
  // Asserted off the reloaded registry, not off the serialized dict: the
  // write side and the read side land independently, so checking the dict
  // would pass while the loader still discarded the policy. Reloaded
  // without overrides, so the loader rebuilds the saved backend itself --
  // the one case where the saved policy still describes what is mounted.
  it('restores the per-mount spec', async () => {
    const ws = new Workspace(
      { '/d': new RAMVFS() },
      { mode: MountMode.WRITE, read: { policy: ReadPolicy.BOUNDED, ttl: 45 } },
    )
    const state = await toStateDict(ws)
    await ws.close()

    const restored = await Workspace.fromState(state, { mode: MountMode.WRITE })
    const mount = restored.namespace.mountFor('/d/x')
    expect(mount.read).toEqual({ policy: ReadPolicy.BOUNDED, ttl: 45 })
    await restored.close()
  })

  it('refuses a v3 snapshot', async () => {
    const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
    const state = await toStateDict(ws)
    await ws.close()
    expect(() => buildMountArgs({ ...state, version: 3 })).toThrow(/v3 not supported/)
  })

  // The absent-version hole, newly reachable: every key the loader read
  // used to have a default, so an unversioned dict was merely odd.
  it('refuses an unversioned snapshot rather than reading it as current', async () => {
    const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
    const state = await toStateDict(ws)
    await ws.close()
    const unversioned: Partial<typeof state> = { ...state }
    delete unversioned.version
    expect(() => buildMountArgs(unversioned as typeof state)).toThrow(/unversioned/)
  })

  // Both doors, or the same bytes get two answers: buildMountArgs builds
  // a workspace from the state, applyStateDict restores into one that
  // exists and is what `version checkout` and the sandbox hydrate call.
  it('refuses a v3 snapshot at the applyStateDict door too', async () => {
    const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
    const state = await toStateDict(ws)
    await ws.close()
    const target = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await target.cache.set('/d/live.txt', new TextEncoder().encode('live'))
      // With replaceCache, which is the `version checkout` path. The
      // check sits above `cache.clear()`; moved one line below it a
      // refused checkout would already have wiped the live cache while
      // still rejecting, so the rejection alone does not pin the order.
      await expect(
        applyStateDict(target, { ...state, version: 3 }, { replaceCache: true }),
      ).rejects.toThrow(/v3 not supported/)
      expect(await target.cache.exists('/d/live.txt')).toBe(true)
    } finally {
      await target.close()
    }
  })

  // `resolveReadSpec` accepts `pinned` by design -- coercion only -- so
  // a snapshot carrying it passes the loader and must be stopped by the
  // mount-time verdict. The constructor door is the same rule reached a
  // different way, and neither was covered.
  it('refuses pinned at the constructor door', async () => {
    const ws = new Workspace({ '/a': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.close()
    expect(
      () =>
        new Workspace(
          { '/a': new RAMVFS() },
          { mode: MountMode.WRITE, read: { policy: ReadPolicy.PINNED, ttl: DEFAULT_READ_TTL } },
        ),
    ).toThrow(/needs a version layer to pin to/)
  })

  it('refuses a snapshot whose mount was saved pinned', async () => {
    const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
    const state = await toStateDict(ws)
    await ws.close()
    for (const m of state.mounts) (m as { read?: string }).read = ReadPolicy.PINNED
    await expect(Workspace.fromState(state, { mode: MountMode.WRITE })).rejects.toThrow(
      /needs a version layer to pin to/,
    )
  })

  // Required, never defaulted: a dict labelled v4 with the key missing
  // would install a default on a mount that was saved carrying something
  // else -- the silent downgrade the whole policy exists to remove.
  it('refuses a v4 entry that is missing its read key', async () => {
    const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
    const state = await toStateDict(ws)
    await ws.close()
    for (const m of state.mounts) delete (m as { read?: string }).read
    expect(() => buildMountArgs(state)).toThrow(/missing its read policy/)
  })

  it('refuses a restored policy it cannot name', async () => {
    const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
    const state = await toStateDict(ws)
    await ws.close()
    for (const m of state.mounts) (m as { read?: string }).read = 'banana'
    expect(() => buildMountArgs(state)).toThrow(/fresh, bounded, pinned/)
  })

  // The distinction the 4th argument to buildMountArgs exists for, and
  // the only shape that can see it. `fromState` merges the mounts it
  // rebuilt into the same map the caller's overrides live in, so without
  // that argument a rebuilt mount -- an s3 mount, a `vfs_ref` script
  // backend -- reads as caller-supplied and is silently reset to the
  // default. Every other test here uses a RAM mount, which is neither
  // rebuilt nor overridden, so both readings agree and the argument
  // could be deleted with nothing red.
  it('keeps the saved spec on a rebuilt mount and drops it on a supplied one', async () => {
    const ws = new Workspace(
      { '/reb': new RAMVFS(), '/sup': new RAMVFS() },
      { mode: MountMode.WRITE, read: { policy: ReadPolicy.BOUNDED, ttl: 45 } },
    )
    const state = await toStateDict(ws)
    await ws.close()

    // As `fromState` hands them over: one map, the caller's own prefixes
    // named separately.
    const merged = { '/reb/': new RAMVFS(), '/sup/': new RAMVFS() }
    const args = buildMountArgs(state, merged, {}, new Set(['/sup/']))

    expect(args.mountArgs['/reb/']?.options.read).toEqual({
      policy: ReadPolicy.BOUNDED,
      ttl: 45,
    })
    expect(args.mountArgs['/sup/']?.options.read).toEqual({
      policy: ReadPolicy.BOUNDED,
      ttl: DEFAULT_READ_TTL,
    })
  })

  // The saved policy belongs to the backend that was saved. An override
  // hands back a different instance -- typically a stand-in with
  // different capabilities -- so replaying the saved verdict onto it can
  // refuse a restore that has nothing wrong with it.
  it('gives an overridden mount the default spec rather than the saved one', async () => {
    const ram = new RAMVFS()
    Object.assign(ram, { cachesReads: true, readRevalidatable: true })
    const ws = new Workspace(
      { '/d': ram },
      { mode: MountMode.WRITE, read: { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL } },
    )
    const state = await toStateDict(ws)
    await ws.close()
    expect(state.mounts[0]?.read).toBe(ReadPolicy.FRESH)

    const restored = await Workspace.fromState(
      state,
      { mode: MountMode.WRITE },
      {
        '/d/': new RAMVFS(),
      },
    )
    try {
      expect(restored.namespace.mountFor('/d/x').read).toEqual({
        policy: ReadPolicy.BOUNDED,
        ttl: DEFAULT_READ_TTL,
      })
    } finally {
      await restored.close()
    }
  })
})
