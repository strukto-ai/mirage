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

import { beforeEach, describe, expect, it } from 'vitest'
import { MountMode, RAMResource, Workspace } from '@struktoai/mirage-node'
import type { LiveFileIdentity } from '@struktoai/mirage-core/ops/types'
import { compareMarkers, FileVersionTracker, StaleMirageFileError } from './file-version.ts'

let ws: Workspace

beforeEach(() => {
  ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
})

// A read seam that answers with something other than the stored bytes.
// Any mount carrying a filetype read op behaves this way: writeFile
// stores one thing and readFile hands back the rendering. The tracker
// reaches the workspace only through these calls, so this is the whole
// of the condition. It names no version of its own, so every check falls
// to the hash rung, which is what a RAM, disk or redis mount does too.
function renderingWs(inner: Workspace): Workspace {
  const prefix = new TextEncoder().encode('rendered:')
  const render = async (path: string): Promise<Uint8Array> => {
    const stored = await inner.fs.readFile(path, { raw: true })
    return new Uint8Array([...prefix, ...stored])
  }
  return {
    fs: {
      readFile: render,
      readFileWithIdentity: async (path: string): Promise<[Uint8Array, null]> => [
        await render(path),
        null,
      ],
      liveIdentity: (): Promise<null> => Promise.resolve(null),
      writeFile: (path: string, content: string | Uint8Array): Promise<void> =>
        inner.fs.writeFile(path, content),
      exists: (path: string): Promise<boolean> => inner.fs.exists(path),
    },
    namespace: inner.namespace,
  } as unknown as Workspace
}

// A backend that names its own versions, the way s3 and gridfs do.
// Every write bumps the marker, readFileWithIdentity hands the marker
// back with the bytes it just read, and liveIdentity answers from the
// same table without touching content. `reads` counts full content
// reads, which is the cost the native path must not pay.
class VersionedFs {
  reads = 0
  identityCalls = 0
  readWithIdentityCalls = 0
  withRevision = true
  withFingerprint = true
  private readonly marks = new Map<string, number>()

  constructor(private readonly inner: Workspace) {}

  private async identity(path: string): Promise<LiveFileIdentity> {
    if (!(await this.inner.fs.exists(path))) {
      return { exists: false, revision: null, fingerprint: null }
    }
    const mark = String(this.marks.get(path) ?? 0)
    return {
      exists: true,
      revision: this.withRevision ? `r${mark}` : null,
      fingerprint: this.withFingerprint ? `f${mark}` : null,
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.reads += 1
    return this.inner.fs.readFile(path, { raw: true })
  }

  // The markers ride the read's own response, the way s3 and gridfs
  // lift an ETag and a VersionId off the GET that carried the bytes.
  async readFileWithIdentity(path: string): Promise<[Uint8Array, LiveFileIdentity]> {
    this.readWithIdentityCalls += 1
    return [await this.readFile(path), await this.identity(path)]
  }

  async liveIdentity(path: string): Promise<LiveFileIdentity> {
    this.identityCalls += 1
    return this.identity(path)
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.inner.fs.writeFile(path, content)
    this.marks.set(path, (this.marks.get(path) ?? 0) + 1)
  }

  exists(path: string): Promise<boolean> {
    return this.inner.fs.exists(path)
  }
}

function versionedWs(inner: Workspace, fs: VersionedFs): Workspace {
  return { fs, namespace: inner.namespace } as unknown as Workspace
}

describe('FileVersionTracker', () => {
  it('refuses a write to a file that changed underneath', async () => {
    const tracker = new FileVersionTracker(ws)
    await ws.fs.writeFile('/a.txt', 'one')
    await tracker.read('/a.txt')
    await ws.fs.writeFile('/a.txt', 'moved underneath')
    await expect(tracker.write('/a.txt', 'two')).rejects.toThrow(StaleMirageFileError)
  })

  it('allows a write that follows its own write', async () => {
    const tracker = new FileVersionTracker(ws)
    await ws.fs.writeFile('/a.txt', 'one')
    await tracker.read('/a.txt')
    await tracker.write('/a.txt', 'two')
    await tracker.write('/a.txt', 'three')
    expect(await ws.fs.readFileText('/a.txt')).toBe('three')
  })

  it('stamps what a later read returns, not the bytes handed in', async () => {
    // Stamping the input would disagree with every later check, which
    // reads it back through the render, and the agent's own next write
    // would be refused as somebody else's change.
    const tracker = new FileVersionTracker(renderingWs(ws))
    await tracker.write('/a.txt', 'one')
    await tracker.write('/a.txt', 'two')
    expect(await ws.fs.readFileText('/a.txt')).toBe('two')
  })

  it('reads for edit after its own write on a rendering mount', async () => {
    const tracker = new FileVersionTracker(renderingWs(ws))
    await tracker.write('/a.txt', 'one')
    expect(new TextDecoder().decode(await tracker.readForEdit('/a.txt'))).toBe('rendered:one')
  })

  it('gives an alias and its target one stamp', async () => {
    // readFile follows the symlink table, so these two spellings are one
    // file. Keyed by spelling, the write below would find no stamp for
    // '/a.txt' and clobber a change the agent never saw.
    const tracker = new FileVersionTracker(ws)
    await ws.fs.writeFile('/a.txt', 'one')
    expect((await ws.execute('ln -s /a.txt /alias.txt')).exitCode).toBe(0)
    await tracker.read('/alias.txt')
    await ws.fs.writeFile('/a.txt', 'moved underneath')
    await expect(tracker.write('/a.txt', 'two')).rejects.toThrow(StaleMirageFileError)
    expect(await ws.fs.readFileText('/a.txt')).toBe('moved underneath')
  })

  it('sees the target read when the edit arrives through the alias', async () => {
    const tracker = new FileVersionTracker(ws)
    await ws.fs.writeFile('/a.txt', 'one')
    expect((await ws.execute('ln -s /a.txt /alias.txt')).exitCode).toBe(0)
    await tracker.read('/a.txt')
    await ws.fs.writeFile('/a.txt', 'moved underneath')
    await expect(tracker.readForEdit('/alias.txt')).rejects.toThrow(StaleMirageFileError)
  })

  it('serves every call unchecked when disabled', async () => {
    const tracker = new FileVersionTracker(ws, false)
    await ws.fs.writeFile('/a.txt', 'one')
    await tracker.read('/a.txt')
    await ws.fs.writeFile('/a.txt', 'moved underneath')
    await tracker.write('/a.txt', 'two')
    expect(await ws.fs.readFileText('/a.txt')).toBe('two')
  })

  it('never asks for identity when disabled', async () => {
    const fs = new VersionedFs(ws)
    const tracker = new FileVersionTracker(versionedWs(ws, fs), false)
    await fs.writeFile('/a.txt', 'one')
    expect((await tracker.read('/a.txt')).toString()).toBe('one')
    expect((await tracker.readForEdit('/a.txt')).toString()).toBe('one')
    await tracker.write('/a.txt', 'two')
    expect(fs.readWithIdentityCalls).toBe(0)
    expect(fs.identityCalls).toBe(0)
  })
})

// A versioned mount whose read renders: markers ride liveIdentity but
// never the read itself, which is drive's gdoc shape (a registered
// filetype read on a mount with an identity op).
class RenderingVersionedFs {
  identityCalls = 0
  private readonly marks = new Map<string, number>()

  constructor(private readonly inner: Workspace) {}

  private async identity(path: string): Promise<LiveFileIdentity> {
    if (!(await this.inner.fs.exists(path))) {
      return { exists: false, revision: null, fingerprint: null }
    }
    return { exists: true, revision: `r${this.marks.get(path) ?? 0}`, fingerprint: null }
  }

  async readFile(path: string): Promise<Uint8Array> {
    const raw = await this.inner.fs.readFile(path, { raw: true })
    return Buffer.concat([Buffer.from('rendered:'), Buffer.from(raw)])
  }

  async readFileWithIdentity(path: string): Promise<[Uint8Array, null]> {
    return [await this.readFile(path), null]
  }

  async liveIdentity(path: string): Promise<LiveFileIdentity> {
    this.identityCalls += 1
    return this.identity(path)
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.inner.fs.writeFile(path, content)
    this.marks.set(path, (this.marks.get(path) ?? 0) + 1)
  }

  exists(path: string): Promise<boolean> {
    return this.inner.fs.exists(path)
  }
}

describe('FileVersionTracker on a rendering versioned mount', () => {
  it('an edit after its own write survives a marker-only restamp', async () => {
    // The restamp keeps the marker and no hash; the rendering read
    // hands back no marker. Without the corner's liveIdentity call the
    // hash rung had nothing to compare and refused a file nobody
    // touched.
    const fs = new RenderingVersionedFs(ws)
    const tracker = new FileVersionTracker(versionedWs(ws, fs as unknown as VersionedFs))
    await tracker.write('/a.txt', 'one')
    const calls = fs.identityCalls
    expect((await tracker.readForEdit('/a.txt')).toString()).toBe('rendered:one')
    expect(fs.identityCalls).toBe(calls + 1)
  })

  it('a marker-only restamp still refuses an outside change', async () => {
    const fs = new RenderingVersionedFs(ws)
    const tracker = new FileVersionTracker(versionedWs(ws, fs as unknown as VersionedFs))
    await tracker.write('/a.txt', 'one')
    await fs.writeFile('/a.txt', 'moved underneath')
    await expect(tracker.readForEdit('/a.txt')).rejects.toThrow(StaleMirageFileError)
  })
})

describe('compareMarkers', () => {
  const both: LiveFileIdentity = { exists: true, revision: 'r1', fingerprint: 'f1' }

  it('takes the strongest rung the two sides share', () => {
    // A revision outranks a fingerprint: the two disagree here and the
    // revision is what the verdict follows.
    const movedRevision: LiveFileIdentity = { exists: true, revision: 'r2', fingerprint: 'f1' }
    expect(compareMarkers(both, both)).toBe('same')
    expect(compareMarkers(both, movedRevision)).toBe('changed')
    const onlyFingerprint: LiveFileIdentity = { exists: true, revision: null, fingerprint: 'f1' }
    expect(compareMarkers(both, onlyFingerprint)).toBe('same')
  })

  it('has nothing to compare without a shared marker', () => {
    const bare: LiveFileIdentity = { exists: true, revision: null, fingerprint: null }
    expect(compareMarkers(both, bare)).toBe('uncomparable')
    expect(compareMarkers(null, both)).toBe('uncomparable')
  })

  it('reads a file the backend says is gone as changed', () => {
    const gone: LiveFileIdentity = { exists: false, revision: null, fingerprint: null }
    expect(compareMarkers(both, gone)).toBe('changed')
    expect(compareMarkers(null, gone)).toBe('changed')
  })
})

describe('FileVersionTracker on a backend that names its versions', () => {
  let fs: VersionedFs
  let tracker: FileVersionTracker

  beforeEach(() => {
    fs = new VersionedFs(ws)
    tracker = new FileVersionTracker(versionedWs(ws, fs))
  })

  it('refuses a stale write without a re-read', async () => {
    await fs.writeFile('/a.txt', 'one')
    await tracker.read('/a.txt')
    const reads = fs.reads
    await fs.writeFile('/a.txt', 'moved underneath')
    await expect(tracker.write('/a.txt', 'two')).rejects.toThrow(StaleMirageFileError)
    // The refusal came from one metadata call, not from a download.
    expect(fs.reads).toBe(reads)
    expect(await ws.fs.readFileText('/a.txt')).toBe('moved underneath')
  })

  it('allows a second write without a re-read', async () => {
    // The restamp after a write is a marker, so the file the agent just
    // wrote is never downloaded to prove it is still its own.
    await fs.writeFile('/a.txt', 'one')
    await tracker.read('/a.txt')
    const reads = fs.reads
    await tracker.write('/a.txt', 'two')
    await tracker.write('/a.txt', 'three')
    expect(fs.reads).toBe(reads)
    expect(await ws.fs.readFileText('/a.txt')).toBe('three')
  })

  it('refuses a write when another one landed before the check', async () => {
    // The blocker this redesign exists for. The stamp is the identity of
    // the bytes the read itself returned, so a writer that lands after
    // that read and before the check moves the live marker away from it
    // and the write is refused. A stamp taken from a second identity
    // call after the read could have been this writer's version, and the
    // genuinely stale write would have gone through.
    await fs.writeFile('/a.txt', 'A')
    await tracker.read('/a.txt')
    const reads = fs.reads
    await fs.writeFile('/a.txt', 'B')
    expect((await fs.liveIdentity('/a.txt')).revision).toBe('r2')
    await expect(tracker.write('/a.txt', 'C')).rejects.toThrow(StaleMirageFileError)
    expect(fs.reads).toBe(reads)
    expect(await ws.fs.readFileText('/a.txt')).toBe('B')
  })

  it('reads a vanished file as stale', async () => {
    await fs.writeFile('/a.txt', 'one')
    await tracker.read('/a.txt')
    const reads = fs.reads
    expect((await ws.execute('rm /a.txt')).exitCode).toBe(0)
    await expect(tracker.write('/a.txt', 'two')).rejects.toThrow(StaleMirageFileError)
    expect(fs.reads).toBe(reads)
  })

  it('drops to the fingerprint when only it is shared', async () => {
    await fs.writeFile('/a.txt', 'one')
    await tracker.read('/a.txt')
    let reads = fs.reads
    // The stamp carries both markers; the backend now names only the
    // weaker one, so the check drops to it rather than to a download.
    fs.withRevision = false
    await tracker.write('/a.txt', 'two')
    expect(fs.reads).toBe(reads)
    await tracker.read('/a.txt')
    reads = fs.reads
    await fs.writeFile('/a.txt', 'moved underneath')
    await expect(tracker.write('/a.txt', 'three')).rejects.toThrow(StaleMirageFileError)
    expect(fs.reads).toBe(reads)
  })

  it('falls to the hash rung when the stamp has no marker', async () => {
    fs.withRevision = false
    fs.withFingerprint = false
    await fs.writeFile('/a.txt', 'one')
    await tracker.read('/a.txt')
    const reads = fs.reads
    // Markers appear only after the stamp was taken, so there is no
    // shared rung and the check falls back to reading the bytes.
    fs.withRevision = true
    fs.withFingerprint = true
    await tracker.write('/a.txt', 'two')
    expect(fs.reads).toBe(reads + 1)
  })

  it('refuses a marker-only stamp once the markers go away', async () => {
    // The one cost of the hash-free write restamp, pinned in the safe
    // direction: a backend that stops naming versions between a write
    // and the next check leaves the stamp with nothing to compare, and
    // the tracker refuses rather than guessing the file is untouched.
    await tracker.write('/a.txt', 'one')
    fs.withRevision = false
    fs.withFingerprint = false
    await expect(tracker.write('/a.txt', 'two')).rejects.toThrow(StaleMirageFileError)
  })

  it('compares a read for edit without a second identity call', async () => {
    // The read it just did carries the current identity, so the ladder
    // runs on what is already in hand.
    await fs.writeFile('/a.txt', 'one')
    await tracker.read('/a.txt')
    const calls = fs.identityCalls
    expect(new TextDecoder().decode(await tracker.readForEdit('/a.txt'))).toBe('one')
    expect(fs.identityCalls).toBe(calls)
    await fs.writeFile('/a.txt', 'moved underneath')
    await expect(tracker.readForEdit('/a.txt')).rejects.toThrow(StaleMirageFileError)
  })
})
