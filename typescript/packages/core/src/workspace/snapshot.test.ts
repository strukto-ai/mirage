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
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { createShellParser, type ShellParser } from '../shell/parse.ts'
import { MountMode } from '../types.ts'
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

describe('Workspace.toStateDict / restore', () => {
  it('roundtrips file content via snapshot + restore', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo "hello" | tee /data/x.txt')
    const state = await ws.toStateDict()
    const ws2 = buildWorkspace()
    await ws2.restore(state)
    const r = await ws2.execute('cat /data/x.txt')
    expect(new TextDecoder().decode(r.stdout)).toBe('hello\n')
    await ws.close()
    await ws2.close()
  })

  it('restores history entries through snapshot + load', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo "one"')
    await ws.execute('echo "two"')
    expect(ws.history.entries().length).toBe(2)
    const path = join(tempDir, 'history.json')
    await ws.snapshot(path)
    const loaded = await Workspace.load(path, {
      mode: MountMode.WRITE,
      ops: new OpsRegistry(),
      shellParser: parser,
    })
    const entries = loaded.history.entries()
    expect(entries.length).toBe(2)
    expect(entries[0]?.command).toBe('echo "one"')
    expect(entries[1]?.command).toBe('echo "two"')
    await ws.close()
    await loaded.close()
  })

  it('restores cache entries even when every mount has redacted config', async () => {
    const ram = new RAMResource()
    ;(ram as unknown as { isRemote: boolean }).isRemote = true
    const ops = new OpsRegistry()
    ops.registerResource(ram)
    const ws = new Workspace({ '/data': ram }, { mode: MountMode.WRITE, ops, shellParser: parser })
    await ws.execute('echo "cached" | tee /data/x.txt > /dev/null')
    await ws.execute('cat /data/x.txt > /dev/null')
    const state = await ws.toStateDict()
    expect(state.cache.entries.length).toBeGreaterThan(0)
    for (const m of state.mounts) {
      Object.assign(m.resourceState, { config: { token: '<REDACTED>' } })
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

  it('skips the .sessions/ observer mount from the snapshot', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo "hi" | tee /data/x.txt')
    const state = await ws.toStateDict()
    for (const m of state.mounts) {
      expect(m.prefix).not.toBe('/.sessions/')
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

  it('rejects snapshots with unsupported format version', async () => {
    const ws = buildWorkspace()
    const path = join(tempDir, 'bad.json')
    await ws.snapshot(path)
    const { readFileSync: rfs, writeFileSync } = await import('node:fs')
    const content = rfs(path, 'utf-8').replace('"version": 2', '"version": 999')
    writeFileSync(path, content)
    await expect(
      Workspace.load(path, { mode: MountMode.WRITE, ops: new OpsRegistry(), shellParser: parser }),
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
      { '/': new RAMResource(), '/ro': new RAMResource() },
      { mode: MountMode.WRITE, modeOverrides: { '/ro': MountMode.READ } },
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

  it('snapshot mode wins over caller-supplied modeOverrides on load', async () => {
    const ws = new Workspace(
      { '/': new RAMResource(), '/ro': new RAMResource() },
      { mode: MountMode.WRITE, modeOverrides: { '/ro': MountMode.READ } },
    )
    const tmp = join(mkdtempSync(join(tmpdir(), 'snap-')), 'ws.tar')
    await ws.snapshot(tmp)
    const loaded = await Workspace.load(tmp, {
      modeOverrides: { '/ro': MountMode.WRITE },
    })
    const roMount = loaded.registry.allMounts().find((m) => m.prefix === '/ro/')
    expect(roMount?.mode).toBe(MountMode.READ)
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
