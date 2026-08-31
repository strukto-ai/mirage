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

import { createHash } from 'node:crypto'
import type { LiveFileIdentity } from '@struktoai/mirage-core/ops/types'
import type { MarkerMatch, Stamp } from './types.ts'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'

export class StaleMirageFileError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`File changed since it was last read: ${path}. Read the file again before modifying it.`)
    this.name = 'StaleMirageFileError'
    this.path = path
  }
}

function fingerprint(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('base64url')
}

async function readBuffer(ws: Workspace, path: string): Promise<Buffer> {
  const bytes = await ws.fs.readFile(path, { raw: true })
  return Buffer.from(bytes)
}

// Compare a stamped identity against the live one, strongest first.
//
// A revision is a durable handle and a fingerprint only a change token,
// so two revisions settle the question and two fingerprints settle it
// one rung lower. A backend that says the file is gone settles it above
// both, which is the tracker's old "no current version" answer.
// Anything else is uncomparable and the caller falls back to hashing
// bytes.
export function compareMarkers(
  stamp: LiveFileIdentity | null,
  current: LiveFileIdentity | null,
): MarkerMatch {
  if (current !== null && !current.exists) return 'changed'
  if (stamp === null || current === null) return 'uncomparable'
  if (stamp.revision !== null && current.revision !== null) {
    return stamp.revision === current.revision ? 'same' : 'changed'
  }
  if (stamp.fingerprint !== null && current.fingerprint !== null) {
    return stamp.fingerprint === current.fingerprint ? 'same' : 'changed'
  }
  return 'uncomparable'
}

// Whether an identity carries a marker the ladder can compare.
function hasMarker(identity: LiveFileIdentity | null): boolean {
  return (
    identity !== null &&
    identity.exists &&
    (identity.revision !== null || identity.fingerprint !== null)
  )
}

// Whether the hash rung says the file moved.
//
// A file that is no longer there has moved, and so has one whose stamp
// never took a baseline: neither can show the bytes are the ones the
// agent saw, and this rung answers what it was asked rather than
// guessing in the permissive direction.
function hashDiffers(stamp: Stamp, currentHash: string | null): boolean {
  return stamp.contentHash === null || currentHash === null || stamp.contentHash !== currentHash
}

// Whether two stamps of one path describe different bytes: the whole
// ladder, for the caller that already holds both the live identity and
// the live bytes (a `readForEdit`, which has just read them) and so owes
// no `liveIdentity` call of its own.
function moved(stamp: Stamp, current: Stamp): boolean {
  const verdict = compareMarkers(stamp.identity, current.identity)
  if (verdict === 'same') return false
  if (verdict === 'changed') return true
  return hashDiffers(stamp, current.contentHash)
}

export class FileVersionTracker {
  private readonly readVersions = new Map<string, Stamp>()
  private readonly editVersions = new Map<string, Stamp>()

  constructor(
    private readonly ws: Workspace,
    private readonly enabled = true,
  ) {}

  // The stamp key for a path: one key per file, not per spelling.
  // readFile and writeFile follow the namespace symlink table, so
  // `/alias` and `/target` are the same file. Keying by the caller's
  // spelling would give each its own stamp, and an edit that arrived
  // through the other name would find no prior version and skip the
  // staleness check entirely.
  private key(path: string): string {
    return this.ws.namespace.follow(path)
  }

  // Hash the bytes the file holds now, the ladder's last rung.
  private async currentHash(path: string): Promise<string | null> {
    if (!(await this.ws.fs.exists(path))) return null
    return fingerprint(await readBuffer(this.ws, path))
  }

  // Refuse unless the file still holds what the stamp describes: one
  // liveIdentity call, then the strongest marker both sides carry. The
  // full re-read only happens when neither side has a marker to compare,
  // which is every mount whose backend has no identity op.
  private async assertVersion(path: string, stamp: Stamp): Promise<void> {
    const current = await this.ws.fs.liveIdentity(path)
    const verdict = compareMarkers(stamp.identity, current)
    if (verdict === 'same') return
    if (verdict === 'uncomparable' && !hashDiffers(stamp, await this.currentHash(path))) return
    throw new StaleMirageFileError(path)
  }

  // Stamp what a later read will return, not the bytes handed in. A
  // mount that does not store writes verbatim answers with something
  // else, so stamping the input would make the very next write or edit
  // look stale with nobody having touched the file. A backend that names
  // its own marker says that much in one metadata call; only a backend
  // that names none has to be read back, and that read is what fills the
  // hash.
  private async recordWrite(path: string, key: string): Promise<void> {
    if (!this.enabled) return
    const identity = await this.ws.fs.liveIdentity(path)
    if (hasMarker(identity)) {
      this.readVersions.set(key, { identity, contentHash: null })
    } else {
      const contentHash = await this.currentHash(path)
      if (contentHash === null) this.readVersions.delete(key)
      else this.readVersions.set(key, { identity, contentHash })
    }
    this.editVersions.delete(key)
  }

  async read(path: string): Promise<Buffer> {
    if (!this.enabled) return readBuffer(this.ws, path)
    const [bytes, identity] = await this.ws.fs.readFileWithIdentity(path, { raw: true })
    const content = Buffer.from(bytes)
    this.readVersions.set(this.key(path), { identity, contentHash: fingerprint(content) })
    return content
  }

  async readForEdit(path: string): Promise<Buffer> {
    if (!this.enabled) return readBuffer(this.ws, path)
    const [bytes, identity] = await this.ws.fs.readFileWithIdentity(path, { raw: true })
    const content = Buffer.from(bytes)
    const key = this.key(path)
    const stamp: Stamp = { identity, contentHash: fingerprint(content) }
    const readStamp = this.readVersions.get(key)
    if (readStamp !== undefined) {
      let changed = moved(readStamp, stamp)
      if (
        changed &&
        identity === null &&
        readStamp.contentHash === null &&
        hasMarker(readStamp.identity)
      ) {
        // A marker-only restamp holds no hash and a rendering read
        // attaches no markers (a versioned mount with a registered
        // filetype read, drive's gdoc rendering), so the ladder above
        // had nothing to compare and refused a file nobody touched.
        // One liveIdentity call restores the marker rung for exactly
        // this corner; every other shape stays zero extra calls.
        const current = await this.ws.fs.liveIdentity(path)
        changed = compareMarkers(readStamp.identity, current) !== 'same'
      }
      if (changed) throw new StaleMirageFileError(path)
    }
    this.editVersions.set(key, stamp)
    return content
  }

  async write(path: string, content: string): Promise<void> {
    const key = this.key(path)
    if (this.enabled) {
      const readStamp = this.readVersions.get(key)
      if (readStamp !== undefined) await this.assertVersion(path, readStamp)
    }
    await this.ws.fs.writeFile(path, content)
    await this.recordWrite(path, key)
  }

  async writeEdit(path: string, content: string): Promise<void> {
    const key = this.key(path)
    if (this.enabled) {
      const editStamp = this.editVersions.get(key)
      if (editStamp !== undefined) await this.assertVersion(path, editStamp)
    }
    await this.ws.fs.writeFile(path, content)
    await this.recordWrite(path, key)
  }
}
