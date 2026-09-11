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

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Accessor } from '../accessor/base.ts'
import { record, revisionFor, runWithRecording, startOp } from '../observe/context.ts'
import { type OpKwargs, OpsRegistry, type RegisteredOp } from '../ops/registry.ts'
import { BaseResource, type Resource } from '../resource/base.ts'
import { createShellParser, type ShellParser } from '../shell/parse/index.ts'
import { splitManifestAndBlobs } from './snapshot/manifest.ts'
import { writeSnapshotTar } from './snapshot/tar_io.ts'
import { ContentType, DriftPolicy, FileStat, FileType, MountMode, type PathSpec } from '../types.ts'
import { ContentDriftError } from './snapshot/drift.ts'
import { toStateDict } from './snapshot/state.ts'
import { Workspace } from './workspace/workspace.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser
let tempDir: string

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
  tempDir = mkdtempSync(join(tmpdir(), 'mirage-drift-'))
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

/**
 * Minimal versioned blob store for drift tests: each `put` advances a
 * revision counter; the read op records ETag + VersionId so the snapshot
 * can recover them at load time.
 */
class FakeRemoteAccessor extends Accessor {
  blobs = new Map<string, { bytes: Uint8Array; fingerprint: string; revision: string }>()
  versionedHistory = new Map<string, Map<string, Uint8Array>>()
  private counter = 0

  put(path: string, bytes: Uint8Array): void {
    this.counter += 1
    const fingerprint = `fp-${path}-${String(this.counter)}`
    const revision = `rev-${path}-${String(this.counter)}`
    this.blobs.set(path, { bytes, fingerprint, revision })
    let history = this.versionedHistory.get(path)
    if (history === undefined) {
      history = new Map()
      this.versionedHistory.set(path, history)
    }
    history.set(revision, bytes)
  }
}

class FakeRemoteResource extends BaseResource implements Resource {
  readonly kind = 'fake-remote'
  readonly cachesReads = true
  readonly supportsSnapshot = true
  readonly accessor: FakeRemoteAccessor

  constructor(accessor: FakeRemoteAccessor) {
    super()
    this.accessor = accessor
  }

  open(): Promise<void> {
    return Promise.resolve()
  }
  override close(): Promise<void> {
    return Promise.resolve()
  }

  stat(p: PathSpec): Promise<FileStat> {
    const entry = this.accessor.blobs.get(p.virtual)
    if (entry === undefined) {
      const err = new Error(`not found: ${p.virtual}`) as Error & { code: string }
      err.code = 'ENOENT'
      return Promise.reject(err)
    }
    return Promise.resolve(
      new FileStat({
        name: p.virtual.split('/').pop() ?? p.virtual,
        size: entry.bytes.byteLength,
        type: FileType.FILE,
        content: ContentType.TEXT,
        fingerprint: entry.fingerprint,
        revision: entry.revision,
      }),
    )
  }

  override getState(): { type: string; config: { token: string } } {
    return { type: this.kind, config: { token: '<REDACTED>' } }
  }
}

const readOp: RegisteredOp = {
  name: 'read',
  resource: 'fake-remote',
  filetype: null,
  write: false,
  fn: (accessor: Accessor, scope: PathSpec, _args: readonly unknown[], _kwargs: OpKwargs) => {
    const acc = accessor as unknown as FakeRemoteAccessor
    const pinned = revisionFor(scope.virtual)
    const entry = acc.blobs.get(scope.virtual)
    if (entry === undefined) {
      const err = new Error(`not found: ${scope.virtual}`) as Error & { code: string }
      err.code = 'ENOENT'
      throw err
    }
    if (pinned !== null) {
      const history = acc.versionedHistory.get(scope.virtual)
      const pinnedBytes = history?.get(pinned)
      if (pinnedBytes !== undefined) {
        record('read', scope.virtual, 'fake-remote', pinnedBytes.byteLength, startOp(), {
          fingerprint: entry.fingerprint,
          revision: pinned,
        })
        return Promise.resolve(pinnedBytes)
      }
    }
    record('read', scope.virtual, 'fake-remote', entry.bytes.byteLength, startOp(), {
      fingerprint: entry.fingerprint,
      revision: entry.revision,
    })
    return Promise.resolve(entry.bytes)
  },
}

const statOp: RegisteredOp = {
  name: 'stat',
  resource: 'fake-remote',
  filetype: null,
  write: false,
  fn: (accessor: Accessor, scope: PathSpec) => {
    const acc = accessor as unknown as FakeRemoteAccessor
    const entry = acc.blobs.get(scope.virtual)
    if (entry === undefined) {
      const err = new Error(`not found: ${scope.virtual}`) as Error & { code: string }
      err.code = 'ENOENT'
      return Promise.reject(err)
    }
    return Promise.resolve(
      new FileStat({
        name: scope.virtual.split('/').pop() ?? scope.virtual,
        size: entry.bytes.byteLength,
        type: FileType.FILE,
        content: ContentType.TEXT,
        fingerprint: entry.fingerprint,
        revision: entry.revision,
      }),
    )
  },
}

function build(accessor: FakeRemoteAccessor): Workspace {
  const ops = new OpsRegistry()
  ops.register(readOp)
  ops.register(statOp)
  const res = new FakeRemoteResource(accessor)
  return new Workspace({ '/remote': res }, { mode: MountMode.WRITE, ops, shellParser: parser })
}

// Wrap a dispatch call in runWithRecording so the captured OpRecord
// reaches `ws.records`, mirroring what `Workspace.execute` does
// implicitly via its `runWithRecording` setup.
async function recordedDispatch(ws: Workspace, op: string, path: string): Promise<unknown> {
  const [result, records] = await runWithRecording(async () => ws.dispatch(op, path))
  ws.records.push(...records)
  return result
}

describe('Workspace snapshot: capture and replay drift detection', () => {
  it('toStateDict captures fingerprint + revision from read-time records', async () => {
    const accessor = new FakeRemoteAccessor()
    accessor.put('/remote/a.txt', new TextEncoder().encode('v1'))
    const ws = build(accessor)
    await recordedDispatch(ws, 'read', '/remote/a.txt')
    const state = await toStateDict(ws)
    expect(state.fingerprints?.length).toBe(1)
    expect(state.fingerprints?.[0]?.path).toBe('/remote/a.txt')
    expect(state.fingerprints?.[0]?.fingerprint).toContain('fp-')
    expect(state.fingerprints?.[0]?.revision).toContain('rev-')
    await ws.close()
  })

  it('STRICT load installs revisions; replay reads pin to the recorded revision', async () => {
    const accessor = new FakeRemoteAccessor()
    accessor.put('/remote/a.txt', new TextEncoder().encode('v1'))
    const ws = build(accessor)
    await recordedDispatch(ws, 'read', '/remote/a.txt')
    const snap = join(tempDir, 'pin.json')
    await ws.snapshot(snap)

    accessor.put('/remote/a.txt', new TextEncoder().encode('v2-upstream'))

    const ops = new OpsRegistry()
    ops.register(readOp)
    ops.register(statOp)
    const loaded = await Workspace.load(
      snap,
      { mode: MountMode.WRITE, ops, shellParser: parser },
      { '/remote/': new FakeRemoteResource(accessor) },
    )
    expect(Object.keys(loaded.revisions).length).toBe(1)
    const bytes = (await loaded.dispatch('read', '/remote/a.txt')) as Uint8Array
    expect(new TextDecoder().decode(bytes)).toBe('v1')
    await ws.close()
    await loaded.close()
  })

  it('STRICT load raises ContentDriftError when fingerprint drifts (no revision pin)', async () => {
    const accessor = new FakeRemoteAccessor()
    accessor.put('/remote/a.txt', new TextEncoder().encode('v1'))
    const ws = build(accessor)
    await recordedDispatch(ws, 'read', '/remote/a.txt')
    const state = await toStateDict(ws)
    // Strip revisions so the loader queues a drift check instead of pinning.
    state.fingerprints = (state.fingerprints ?? []).map((e) => ({
      path: e.path,
      mount_prefix: e.mount_prefix,
      fingerprint: e.fingerprint ?? null,
    }))
    const snap = join(tempDir, 'drift.tar')
    const [manifest, blobs] = splitManifestAndBlobs(state as unknown as Record<string, unknown>)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(snap, await writeSnapshotTar(manifest, blobs))

    accessor.put('/remote/a.txt', new TextEncoder().encode('v2'))

    const ops = new OpsRegistry()
    ops.register(readOp)
    ops.register(statOp)
    const loaded = await Workspace.load(
      snap,
      { mode: MountMode.WRITE, ops, shellParser: parser, driftPolicy: DriftPolicy.STRICT },
      { '/remote/': new FakeRemoteResource(accessor) },
    )
    await expect(loaded.dispatch('read', '/remote/a.txt')).rejects.toBeInstanceOf(ContentDriftError)
    await ws.close()
    await loaded.close()
  })

  it('STRICT load checks drift on the fs facade too, not only Workspace.dispatch', async () => {
    // The fs facade (the FUSE path) reaches the dispatcher without
    // passing Workspace.dispatch, so the pending fingerprint checks
    // must run at the door itself or a first op through FUSE touches
    // drifted state unchecked.
    const accessor = new FakeRemoteAccessor()
    accessor.put('/remote/a.txt', new TextEncoder().encode('v1'))
    const ws = build(accessor)
    await recordedDispatch(ws, 'read', '/remote/a.txt')
    const state = await toStateDict(ws)
    state.fingerprints = (state.fingerprints ?? []).map((e) => ({
      path: e.path,
      mount_prefix: e.mount_prefix,
      fingerprint: e.fingerprint ?? null,
    }))
    const snap = join(tempDir, 'drift-facade.tar')
    const [manifest, blobs] = splitManifestAndBlobs(state as unknown as Record<string, unknown>)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(snap, await writeSnapshotTar(manifest, blobs))

    accessor.put('/remote/a.txt', new TextEncoder().encode('v2'))

    const ops = new OpsRegistry()
    ops.register(readOp)
    ops.register(statOp)
    const loaded = await Workspace.load(
      snap,
      { mode: MountMode.WRITE, ops, shellParser: parser, driftPolicy: DriftPolicy.STRICT },
      { '/remote/': new FakeRemoteResource(accessor) },
    )
    await expect(loaded.fs.readFile('/remote/a.txt')).rejects.toBeInstanceOf(ContentDriftError)
    await ws.close()
    await loaded.close()
  })

  it('OFF load skips drift check and leaves revision pins empty', async () => {
    const accessor = new FakeRemoteAccessor()
    accessor.put('/remote/a.txt', new TextEncoder().encode('v1'))
    const ws = build(accessor)
    await recordedDispatch(ws, 'read', '/remote/a.txt')
    const snap = join(tempDir, 'off.json')
    await ws.snapshot(snap)
    accessor.put('/remote/a.txt', new TextEncoder().encode('v2-upstream'))

    const ops = new OpsRegistry()
    ops.register(readOp)
    ops.register(statOp)
    const loaded = await Workspace.load(
      snap,
      { mode: MountMode.WRITE, ops, shellParser: parser, driftPolicy: DriftPolicy.OFF },
      { '/remote/': new FakeRemoteResource(accessor) },
    )
    expect(Object.keys(loaded.revisions).length).toBe(0)
    const bytes = (await loaded.dispatch('read', '/remote/a.txt')) as Uint8Array
    expect(new TextDecoder().decode(bytes)).toBe('v2-upstream')
    await ws.close()
    await loaded.close()
  })
})

it.each(['state', 'copy'])(
  'snapshot prepares new mounts before capturing cache (%s)',
  async (capture) => {
    const accessor = new FakeRemoteAccessor()
    accessor.put('/remote/data/file', new TextEncoder().encode('old'))
    accessor.put('/remote/outside', new TextEncoder().encode('keep'))
    accessor.put('/remote/data2/file', new TextEncoder().encode('sibling'))
    const ws = build(accessor)
    const fresh = new FakeRemoteAccessor()
    fresh.put('/remote/data/file', new TextEncoder().encode('new'))
    const replacement = new FakeRemoteResource(fresh)
    let clone: Workspace | undefined
    try {
      for (const path of ['/remote/data/file', '/remote/outside', '/remote/data2/file']) {
        const bytes = await recordedDispatch(ws, 'read', path)
        if (!(bytes instanceof Uint8Array)) throw new Error('expected read bytes')
        await ws.cache.set(path, bytes)
      }
      expect(await ws.cache.get('/remote/data/file')).toEqual(new TextEncoder().encode('old'))
      ws.addMount('/remote/data', replacement)
      if (capture === 'copy') {
        clone = await ws.copy()
      } else {
        const state = await toStateDict(ws)
        expect(state.cache.entries.map((e) => e.key)).not.toContain('/remote/data/file')
        const ops = new OpsRegistry()
        ops.register(readOp)
        ops.register(statOp)
        clone = await Workspace.fromState(
          state,
          { ops, shellParser: parser },
          {
            '/remote': ws.mount('/remote').resource,
            '/remote/data': replacement,
          },
        )
      }
      expect(await clone.cache.get('/remote/data/file')).toBeNull()
      expect(await clone.cache.get('/remote/outside')).toEqual(new TextEncoder().encode('keep'))
      expect(await clone.cache.get('/remote/data2/file')).toEqual(
        new TextEncoder().encode('sibling'),
      )
      const bytes = await clone.dispatch('read', '/remote/data/file')
      expect(bytes).toEqual(new TextEncoder().encode('new'))
    } finally {
      await clone?.close()
      await ws.close()
    }
  },
)

it.each([
  { shadow: false, delayed: false },
  { shadow: true, delayed: false },
  { shadow: false, delayed: true },
  { shadow: true, delayed: true },
])(
  'snapshot keeps read mount ownership (shadow=$shadow, delayed=$delayed)',
  async ({ shadow, delayed }) => {
    const old = new FakeRemoteAccessor()
    const fresh = new FakeRemoteAccessor()
    old.put('/remote/data/file', new TextEncoder().encode('old'))
    fresh.put('/remote/data/file', new TextEncoder().encode('new'))
    fresh.put('/remote/data/file', new TextEncoder().encode('newer'))
    const keep = new FakeRemoteAccessor()
    keep.put('/remote/data/nested/file', new TextEncoder().encode('keep'))
    const ops = new OpsRegistry()
    ops.register(readOp)
    ops.register(statOp)
    const ws = new Workspace(
      {
        [shadow ? '/remote' : '/remote/data']: new FakeRemoteResource(old),
        '/remote/data/nested': new FakeRemoteResource(keep),
      },
      { ops, shellParser: parser },
    )
    let enter = (): void => undefined
    let resume = (): void => undefined
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const release = new Promise<void>((resolve) => {
      resume = resolve
    })
    let reading: Promise<unknown> | undefined
    try {
      await recordedDispatch(ws, 'read', '/remote/data/nested/file')
      if (delayed) {
        reading = runWithRecording(async () => {
          const result = await ws.dispatch('read', '/remote/data/file')
          enter()
          await release
          return result
        }).then(([result, records]) => {
          ws.records.push(...records)
          return result
        })
        await entered
      } else {
        await recordedDispatch(ws, 'read', '/remote/data/file')
      }
      if (!shadow) await ws.unmount('/remote/data')
      ws.addMount('/remote/data', new FakeRemoteResource(fresh))
      resume()
      await reading
      const before = await toStateDict(ws)
      expect(before.fingerprints?.map((e) => e.path)).toEqual(['/remote/data/nested/file'])
      await recordedDispatch(ws, 'read', '/remote/data/file')
      const after = await toStateDict(ws)
      expect(after.fingerprints).toContainEqual({
        path: '/remote/data/file',
        mount_prefix: '/remote/data/',
        fingerprint: fresh.blobs.get('/remote/data/file')?.fingerprint,
        revision: fresh.blobs.get('/remote/data/file')?.revision,
      })
      expect(after.fingerprints?.map((e) => e.path)).toContain('/remote/data/nested/file')
    } finally {
      resume()
      await reading
      await ws.close()
    }
  },
)

it('snapshot rejects fingerprints from a retired lazy op', async () => {
  const old = new FakeRemoteAccessor()
  old.put('/remote/file', new TextEncoder().encode('old'))
  const ops = new OpsRegistry()
  ops.register({
    ...readOp,
    fn: async function* (accessor, scope) {
      const entry = (accessor as FakeRemoteAccessor).blobs.get(scope.virtual)
      if (entry === undefined) throw new Error('missing fixture')
      record('read', scope.virtual, 'fake-remote', entry.bytes.length, startOp(), {
        fingerprint: entry.fingerprint,
        revision: entry.revision,
      })
      yield await Promise.resolve(entry.bytes)
    },
  })
  const ws = new Workspace({ '/remote': new FakeRemoteResource(old) }, { ops, shellParser: parser })
  try {
    const id = ws.mount('/remote').mountId
    const [, records] = await runWithRecording(async () => {
      const stream = (await ws.dispatch('read', '/remote/file')) as AsyncIterable<Uint8Array>
      const removing = ws.unmount('/remote')
      await vi.waitFor(() => {
        expect(ws.registry.tryMountForPrefix('/remote')).toBeNull()
      })
      ws.addMount('/remote', new FakeRemoteResource(new FakeRemoteAccessor()))
      for await (const chunk of stream) expect(chunk).toEqual(new TextEncoder().encode('old'))
      await removing
    })
    ws.records.push(...records)
    expect(records[0]?.mountId).toBe(id)
    expect((await toStateDict(ws)).fingerprints).toEqual([])
  } finally {
    await ws.close()
  }
})

it.each([false, true])(
  'restored drift checks do not follow replaced mounts (shadow=%s)',
  async (shadow) => {
    const prefix = shadow ? '/remote' : '/remote/data'
    const ancestor = new FakeRemoteResource(new FakeRemoteAccessor())
    const fresh = new FakeRemoteAccessor()
    fresh.put('/remote/data/file', new TextEncoder().encode('new'))
    const ops = new OpsRegistry()
    ops.register(readOp)
    ops.register(statOp)
    const source = new Workspace({ [prefix]: ancestor }, { ops, shellParser: parser })
    let loaded: Workspace | undefined
    try {
      const state = await toStateDict(source)
      state.fingerprints = [
        { path: '/remote/data/file', mount_prefix: prefix, fingerprint: 'old-account' },
      ]
      loaded = await Workspace.fromState(
        state,
        { ops, shellParser: parser },
        { [prefix]: ancestor },
      )
      if (!shadow) await loaded.unmount('/remote/data')
      loaded.addMount('/remote/data', new FakeRemoteResource(fresh))
      ops.register(readOp)
      ops.register(statOp)
      expect(await loaded.dispatch('read', '/remote/data/file')).toEqual(
        new TextEncoder().encode('new'),
      )
    } finally {
      await loaded?.close()
      await source.close()
    }
  },
)

it.each(
  ['snapshot', 'copy'].flatMap((surface) => [false, true].map((opened) => ({ surface, opened }))),
)(
  'unmount waits for asynchronous $surface state reads (opened=$opened)',
  async ({ surface, opened }) => {
    let enter = (): void => undefined
    let resume = (): void => undefined
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const release = new Promise<void>((resolve) => {
      resume = resolve
    })
    let closed = false
    class AsyncStateResource extends BaseResource {
      readonly kind = 'ram'
      open(): Promise<void> {
        return Promise.resolve()
      }
      override async getState(): Promise<{ type: string }> {
        enter()
        await release
        expect(closed).toBe(false)
        return { type: 'ram' }
      }
      override async close(): Promise<void> {
        closed = true
        await super.close()
      }
    }
    const resource = new AsyncStateResource()
    const ws = new Workspace({ '/data': resource }, { shellParser: parser })
    if (opened) await ws.resolve('/data')
    const capture = (
      surface === 'copy' ? ws.copy() : ws.snapshot(join(tempDir, 'retired.tar'))
    ).catch((error: unknown) => error)
    let removing: Promise<void> | undefined
    try {
      await entered
      let removed = false
      removing = ws.unmount('/data').then(() => {
        removed = true
      })
      await vi.waitFor(() => {
        expect(ws.registry.tryMountForPrefix('/data')).toBeNull()
      })
      expect(removed).toBe(false)
      expect(closed).toBe(false)
      resume()
      const result: unknown = await capture
      expect(result).toBeInstanceOf(Error)
      expect(String(result)).toContain('mounts changed during snapshot')
      await removing
      expect(closed).toBe(true)
    } finally {
      resume()
      await Promise.allSettled([capture, ...(removing === undefined ? [] : [removing])])
      await ws.close()
    }
  },
)
