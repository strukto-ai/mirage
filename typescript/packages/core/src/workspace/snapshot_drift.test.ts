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
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Accessor } from '../accessor/base.ts'
import { record, revisionFor, runWithRecording } from '../observe/context.ts'
import { type OpKwargs, OpsRegistry, type RegisteredOp } from '../ops/registry.ts'
import type { Resource } from '../resource/base.ts'
import { createShellParser, type ShellParser } from '../shell/parse.ts'
import { DriftPolicy, FileStat, FileType, MountMode, type PathSpec } from '../types.ts'
import { ContentDriftError } from './snapshot/drift.ts'
import { Workspace } from './workspace.ts'

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

class FakeRemoteResource implements Resource {
  readonly kind = 'fake-remote'
  readonly isRemote = true
  readonly supportsSnapshot = true
  readonly accessor: FakeRemoteAccessor

  constructor(accessor: FakeRemoteAccessor) {
    this.accessor = accessor
  }

  open(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }

  stat(p: PathSpec): Promise<FileStat> {
    const entry = this.accessor.blobs.get(p.original)
    if (entry === undefined) {
      const err = new Error(`not found: ${p.original}`) as Error & { code: string }
      err.code = 'ENOENT'
      return Promise.reject(err)
    }
    return Promise.resolve(
      new FileStat({
        name: p.original.split('/').pop() ?? p.original,
        size: entry.bytes.byteLength,
        type: FileType.TEXT,
        fingerprint: entry.fingerprint,
        revision: entry.revision,
      }),
    )
  }

  getState(): { type: string; needsOverride: boolean } {
    return { type: this.kind, needsOverride: true }
  }
}

const readOp: RegisteredOp = {
  name: 'read',
  resource: 'fake-remote',
  filetype: null,
  write: false,
  fn: (accessor: Accessor, scope: PathSpec, _args: readonly unknown[], _kwargs: OpKwargs) => {
    const acc = accessor as unknown as FakeRemoteAccessor
    const pinned = revisionFor(scope.original)
    const entry = acc.blobs.get(scope.original)
    if (entry === undefined) {
      const err = new Error(`not found: ${scope.original}`) as Error & { code: string }
      err.code = 'ENOENT'
      throw err
    }
    if (pinned !== null) {
      const history = acc.versionedHistory.get(scope.original)
      const pinnedBytes = history?.get(pinned)
      if (pinnedBytes !== undefined) {
        record('read', scope.original, 'fake-remote', pinnedBytes.byteLength, performance.now(), {
          fingerprint: entry.fingerprint,
          revision: pinned,
        })
        return Promise.resolve(pinnedBytes)
      }
    }
    record('read', scope.original, 'fake-remote', entry.bytes.byteLength, performance.now(), {
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
    const entry = acc.blobs.get(scope.original)
    if (entry === undefined) {
      const err = new Error(`not found: ${scope.original}`) as Error & { code: string }
      err.code = 'ENOENT'
      return Promise.reject(err)
    }
    return Promise.resolve(
      new FileStat({
        name: scope.original.split('/').pop() ?? scope.original,
        size: entry.bytes.byteLength,
        type: FileType.TEXT,
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
    const state = await ws.toStateDict()
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
    const state = await ws.toStateDict()
    // Strip revisions so the loader queues a drift check instead of pinning.
    state.fingerprints = (state.fingerprints ?? []).map((e) => ({
      path: e.path,
      mountPrefix: e.mountPrefix,
      fingerprint: e.fingerprint ?? null,
    }))
    const snap = join(tempDir, 'drift.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(snap, JSON.stringify(state))

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
