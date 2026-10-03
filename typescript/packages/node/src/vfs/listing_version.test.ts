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

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as UtilsModule from '../core/disk/utils.ts'
import { ListingCheckStore } from '@struktoai/mirage-core/cache/index/ram'
import type { FileStat } from '@struktoai/mirage-core/types'
import { ListingVersion, MountMode, PathSpec, ReadPolicy } from '@struktoai/mirage-core/types'
import type { MountEntry } from '@struktoai/mirage-core/workspace/mount/mount'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { Reconciler } from '@struktoai/mirage-core/workspace/reconcile'
import { Workspace as NodeWorkspace } from '../workspace.ts'
import { FakeHub, serveHub } from '../core/hf_hub/_test_util.ts'
import * as diskUtils from '../core/disk/utils.ts'
import { DiskVFS } from './disk/disk.ts'
import { InlineGitHub } from './fixtures/github.ts'
import { buildVfs } from './registry.ts'

vi.mock('../core/disk/utils.ts', async (importOriginal) => {
  const original = await importOriginal<typeof UtilsModule>()
  return { ...original, readEntries: vi.fn(original.readEntries) }
})

interface Harness {
  ws: NodeWorkspace
  key: string
  nested: string
  counts: () => [number, number]
  change: () => void
  close?: () => Promise<void>
  // The checks one command listing `key` and `nested` sends: one for a MOUNT
  // version, one per folder for a FOLDER version.
  checks?: number
}

async function githubHarness(): Promise<Harness> {
  const gh = new InlineGitHub({ 'docs/sub/a.txt': 'a\n', 'top.txt': 't\n' })
  vi.stubGlobal('fetch', gh.fetch)
  const vfs = await buildVfs('github', {
    token: 't',
    owner: 'o',
    repo: 'r',
    ref: 'main',
    base_url: gh.url,
  })
  const ws = new NodeWorkspace({
    '/m': new Mount(vfs, { mode: MountMode.READ, read: { policy: ReadPolicy.FRESH, ttl: 600 } }),
  })
  return {
    ws,
    key: '/m',
    nested: '/m/docs/sub',
    counts: () => [gh.count('dir'), gh.count('recursive')],
    change: () => {
      gh.set('docs/new.txt', 'n\n')
    },
  }
}

function hfHarness(name: string, segment: string): () => Promise<Harness> {
  return async () => {
    const hub = new FakeHub()
    const files = hub.files(segment)
    files.set('docs/sub/a.txt', new TextEncoder().encode('a\n'))
    files.set('top.txt', new TextEncoder().encode('t\n'))
    await serveHub(hub)
    const vfs = await buildVfs(name, { repo_id: 'acme/widget', endpoint: hub.url })
    const ws = new NodeWorkspace({
      '/m': new Mount(vfs, { mode: MountMode.READ, read: { policy: ReadPolicy.FRESH, ttl: 600 } }),
    })
    return {
      ws,
      key: '/m',
      nested: '/m/docs/sub',
      counts: () => [hub.count('revision'), hub.count('tree')],
      change: () => {
        files.set('docs/new.txt', new TextEncoder().encode('n\n'))
      },
      close: () => hub.close(),
    }
  }
}

function changedNs(folder: string): bigint {
  const st = statSync(folder, { bigint: true })
  return st.ctimeNs > st.mtimeNs ? st.ctimeNs : st.mtimeNs
}

async function diskHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'mirage-disk-contract-'))
  mkdirSync(join(root, 'docs', 'sub'), { recursive: true })
  writeFileSync(join(root, 'docs', 'sub', 'a.txt'), 'a\n')
  writeFileSync(join(root, 'top.txt'), 't\n')
  // The clock rule: 3 s past the latest change of every folder listed,
  // re-read after each outside change, so no version is withheld by the
  // racy guard.
  const settle = (): void => {
    const latest = [root, join(root, 'docs', 'sub')]
      .map(changedNs)
      .reduce((a, b) => (a > b ? a : b))
    vi.setSystemTime(Number(latest / 1000000n) + 3000)
  }
  vi.useFakeTimers({ toFake: ['Date'] })
  settle()
  const actual = await vi.importActual<typeof UtilsModule>('../core/disk/utils.ts')
  let scans = 0
  vi.mocked(diskUtils.readEntries).mockImplementation(async (directory: string) => {
    scans += 1
    return actual.readEntries(directory)
  })
  const proto = Reconciler.prototype as unknown as {
    listingFingerprint: (mount: unknown, path: string) => Promise<string | null>
  }
  const check = proto.listingFingerprint
  let checks = 0
  vi.spyOn(proto, 'listingFingerprint').mockImplementation(async function (
    this: unknown,
    mount: unknown,
    path: string,
  ) {
    checks += 1
    return check.call(this, mount, path)
  })
  const vfs = await buildVfs('disk', { root })
  const ws = new NodeWorkspace({
    '/m': new Mount(vfs, { mode: MountMode.WRITE, read: { policy: ReadPolicy.FRESH, ttl: 600 } }),
  })
  return {
    ws,
    key: '/m',
    nested: '/m/docs/sub',
    counts: () => [checks, scans],
    change: () => {
      writeFileSync(join(root, 'new.txt'), 'n\n')
      settle()
    },
    close: () => {
      vi.useRealTimers()
      rmSync(root, { recursive: true, force: true })
      return Promise.resolve()
    },
    checks: 2,
  }
}

// A declarer gets a harness proving that its check and its fill agree, so
// the gate's stat and the stored version are one kind of token. Each
// declaring backend adds its row with its declaration.
const HARNESSES: Record<string, () => Promise<Harness>> = {
  github: githubHarness,
  hf_models: hfHarness('hf_models', 'models'),
  hf_datasets: hfHarness('hf_datasets', 'datasets'),
  hf_spaces: hfHarness('hf_spaces', 'spaces'),
  disk: diskHarness,
}

async function shell(ws: NodeWorkspace, line: string): Promise<void> {
  const result = await ws.shell(line)
  expect([result.exitCode, new TextDecoder().decode(result.stderr)], line).toEqual([0, ''])
}

async function throwawayStat(ws: NodeWorkspace, mount: MountEntry, key: string): Promise<FileStat> {
  const spec = new PathSpec({ virtual: key, directory: '/', vfsPath: '' })
  return (await ws.opsRegistry.call('stat', mount.vfs, mount.vfs.accessor, spec, [], {
    index: new ListingCheckStore(),
  })) as FileStat
}

async function checkContract(name: string): Promise<void> {
  const make = HARNESSES[name]
  if (make === undefined) throw new Error(`no harness for ${name}`)
  const harness = await make()
  const { ws } = harness
  try {
    const mount = ws.registry.mountFor(harness.key)
    await shell(ws, `ls ${harness.key} ${harness.nested}`)
    const store = mount.indexStore
    const stored = (await store.listDir(harness.key)).version ?? null
    expect(stored).not.toBeNull()
    expect((await store.listDir(harness.nested)).version ?? null).not.toBeNull()
    const remote = await throwawayStat(ws, mount, harness.key)
    expect(remote.fingerprint).toBe(stored)
    const before = harness.counts()
    await shell(ws, `ls ${harness.key} ${harness.nested}`)
    const after = harness.counts()
    expect([after[0] - before[0], after[1] - before[1]]).toEqual([harness.checks ?? 1, 0])
    expect(mount.vfs.listingVersion).not.toBe(ListingVersion.NONE)
    harness.change()
    const moved = await throwawayStat(ws, mount, harness.key)
    expect(moved.fingerprint ?? null).not.toBeNull()
    expect(moved.fingerprint).not.toBe(stored)
  } finally {
    await ws.close()
    await harness.close?.()
  }
}

describe('listing version declarations', () => {
  it('the harness roster is pinned', () => {
    // A literal, not the derived set: the expectation must not move with the
    // spec it checks.
    expect(Object.keys(HARNESSES).sort()).toEqual([
      'disk',
      'github',
      'hf_datasets',
      'hf_models',
      'hf_spaces',
    ])
  })
})

describe('a declarer checks what its fill stored', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.mocked(diskUtils.readEntries).mockReset()
    vi.unstubAllGlobals()
  })

  it.each(Object.keys(HARNESSES).sort())('%s', async (name) => {
    await checkContract(name)
  })
})

describe('disk folder versions knob', () => {
  it('turning folder versions off leaves the declaration', () => {
    const root = mkdtempSync(join(tmpdir(), 'mirage-disk-knob-'))
    try {
      const off = new DiskVFS({ root, folderVersions: false })
      const on = new DiskVFS({ root })
      expect(off.listingVersion).toBe(ListingVersion.NONE)
      expect(on.listingVersion).toBe(ListingVersion.FOLDER)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
