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

import { ContentDriftError } from '@struktoai/mirage-core/workspace/snapshot/drift'
import { DriftPolicy, MountMode } from '@struktoai/mirage-core/types'
import { toStateDict } from '@struktoai/mirage-core/workspace/snapshot/state'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { S3Config } from '../vfs/s3/config.ts'
import { installS3Mock, type S3Mock } from '../vfs/s3/mock.ts'
import { S3VFS } from '../vfs/s3/s3.ts'
import { Workspace } from '../workspace.ts'

const BUCKET = 'retract-bucket'
const INNER = 'retract-inner-bucket'
const ENC = new TextEncoder()
const DEC = new TextDecoder()

function makeConfig(): S3Config {
  return {
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: 'fake',
    secretAccessKey: 'fake',
    forcePathStyle: true,
  }
}

function makeWorkspace(): Workspace {
  return new Workspace({ '/s3': new S3VFS(makeConfig()) }, { mode: MountMode.WRITE })
}

describe('fingerprint retraction (mocked S3)', () => {
  let mock: S3Mock

  beforeAll(() => {
    mock = installS3Mock(undefined, { etagSuffix: '-2' })
  })

  afterEach(() => {
    // Only the store: `reset()` would clear the registered command
    // behaviours and leave the mock inert.
    for (const b of mock.store.allBuckets()) mock.store.objects(b).clear()
    mock.calls.clear()
  })

  afterAll(() => {
    mock.restore()
  })

  it('a written path is captured for drift', async () => {
    // #1018: the write stamps a token but capture used to ignore it, so
    // an out-of-band change to a path mirage wrote went undetected.
    const ws = makeWorkspace()
    try {
      await ws.shell('tee /s3/x.txt <<< v1')
      const state = await toStateDict(ws)
      expect(state.fingerprints?.map((f) => f.path)).toEqual(['/s3/x.txt'])
    } finally {
      await ws.close()
    }
  })

  it('a written path raises on a STRICT load after an out-of-band change', async () => {
    const ws = makeWorkspace()
    let state
    try {
      await ws.shell('tee /s3/x.txt <<< v1')
      state = await toStateDict(ws)
    } finally {
      await ws.close()
    }
    mock.store.set(BUCKET, 'x.txt', ENC.encode('v2\n'))
    const loaded = await Workspace.fromState(state, {}, { '/s3': new S3VFS(makeConfig()) })
    try {
      await expect(loaded.shell('cat /s3/x.txt')).rejects.toThrow(ContentDriftError)
    } finally {
      await loaded.close()
    }
  })

  it('a written path serves current state under DriftPolicy.OFF', async () => {
    const ws = makeWorkspace()
    let state
    try {
      await ws.shell('tee /s3/x.txt <<< v1')
      state = await toStateDict(ws)
    } finally {
      await ws.close()
    }
    mock.store.set(BUCKET, 'x.txt', ENC.encode('v2\n'))
    const loaded = await Workspace.fromState(
      state,
      { driftPolicy: DriftPolicy.OFF },
      { '/s3': new S3VFS(makeConfig()) },
    )
    try {
      const read = await loaded.shell('cat /s3/x.txt')
      expect(DEC.decode(read.stdout)).toBe('v2\n')
    } finally {
      await loaded.close()
    }
  })

  it('a STRICT load succeeds when the written object is unchanged', async () => {
    // The cheapest regression test for the whole write-pinning change:
    // if a driver's put token and its head token ever disagreed, every
    // STRICT load of a written path would fail and nothing else here
    // would notice.
    const ws = makeWorkspace()
    let state
    try {
      await ws.shell('tee /s3/x.txt <<< v1')
      state = await toStateDict(ws)
    } finally {
      await ws.close()
    }
    const loaded = await Workspace.fromState(state, {}, { '/s3': new S3VFS(makeConfig()) })
    try {
      const read = await loaded.shell('cat /s3/x.txt')
      expect(DEC.decode(read.stdout)).toBe('v1\n')
    } finally {
      await loaded.close()
    }
  })

  it('a refused removal leaves no stale bytes for a STRICT load', async () => {
    // A delete the store refused before touching anything still retracts
    // the pin, so the cached body has to go with it: left behind, a
    // restored snapshot would serve the pre-change bytes with nothing
    // left to check them, the hole #1018 reported.
    mock.store.set(BUCKET, 'x.txt', ENC.encode('v1\n'))
    const refused = vi.spyOn(mock.store, 'delete').mockImplementation(() => {
      throw new Error('AccessDenied')
    })
    const ws = makeWorkspace()
    let state
    try {
      await ws.shell('cat /s3/x.txt')
      const rm = await ws.shell('rm /s3/x.txt; echo rm=$?')
      expect(DEC.decode(rm.stdout)).toBe('rm=1\n')
      state = await toStateDict(ws)
    } finally {
      refused.mockRestore()
      await ws.close()
    }
    expect(state.fingerprints).toEqual([])
    expect(mock.store.get(BUCKET, 'x.txt')).toEqual(ENC.encode('v1\n'))
    mock.store.set(BUCKET, 'x.txt', ENC.encode('v2\n'))
    const loaded = await Workspace.fromState(state, {}, { '/s3': new S3VFS(makeConfig()) })
    try {
      const read = await loaded.shell('cat /s3/x.txt')
      expect(DEC.decode(read.stdout)).toBe('v2\n')
    } finally {
      await loaded.close()
    }
  })

  it('write then move leaves no pin to fail the load', async () => {
    // The idiom a naive widening would break: the temp path is pinned by
    // the write and must be retracted by the move, or a STRICT load
    // raises on a path the agent deliberately moved.
    const ws = makeWorkspace()
    let state
    try {
      await ws.shell('tee /s3/tmp.txt <<< v1')
      // Positive control: without it this test also passes on a base
      // where a written path was never pinned at all.
      expect((await toStateDict(ws)).fingerprints?.map((f) => f.path)).toEqual(['/s3/tmp.txt'])
      await ws.shell('mv /s3/tmp.txt /s3/final.txt')
      state = await toStateDict(ws)
      expect(state.fingerprints).toEqual([])
    } finally {
      await ws.close()
    }
    const loaded = await Workspace.fromState(state, {}, { '/s3': new S3VFS(makeConfig()) })
    try {
      const read = await loaded.shell('cat /s3/final.txt')
      expect(DEC.decode(read.stdout)).toBe('v1\n')
    } finally {
      await loaded.close()
    }
  })

  it('a subtree retraction spares a nested mount', async () => {
    // The owner bounding, through the real registry rather than a stub.
    // A nested mount's keys live in a different backend, so the outer
    // mount's `rm -r` never touched them; an unbounded sweep would drop
    // their pins and silently lose their drift check.
    const ws = new Workspace(
      {
        '/s3': new S3VFS(makeConfig()),
        '/s3/d/inner': new S3VFS({ ...makeConfig(), bucket: INNER }),
      },
      { mode: MountMode.WRITE },
    )
    try {
      await ws.shell('tee /s3/d/x.txt <<< v1')
      await ws.shell('tee /s3/d/inner/y.txt <<< v1')
      await ws.shell('rm -r /s3/d')
      const state = await toStateDict(ws)
      expect(state.fingerprints?.map((f) => f.path).sort()).toEqual(['/s3/d/inner/y.txt'])
    } finally {
      await ws.close()
    }
  })

  it('moving one object spares an independent descendant pin', async () => {
    // `a` and `a/child` are independent keys on a keyed store, so
    // `mv a b` moves the single object at `a` and never touches
    // `a/child`. Both rename paths used to record the same op name, so
    // capture treated a one-object move as a prefix move and dropped a
    // pin for an object that had not moved.
    const ws = makeWorkspace()
    try {
      await ws.shell('tee /s3/a <<< A')
      await ws.shell('tee /s3/a/child <<< C')
      await ws.shell('mv /s3/a /s3/b')
      const state = await toStateDict(ws)
      expect([...mock.store.objects(BUCKET).keys()].sort()).toEqual(['a/child', 'b'])
      expect(state.fingerprints?.map((f) => f.path).sort()).toEqual(['/s3/a/child'])
    } finally {
      await ws.close()
    }
  })
})
