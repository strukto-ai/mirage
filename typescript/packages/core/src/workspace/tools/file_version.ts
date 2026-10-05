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

import type { Ops } from '../../ops/ops.ts'
import { encodeBase64 } from '../../utils/base64.ts'

export class StaleMirageFileError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`File changed since it was last read: ${path}. Read the file again before modifying it.`)
    this.name = 'StaleMirageFileError'
    this.path = path
  }
}

/**
 * Version stamp for one file's stored bytes.
 *
 * @param content The bytes to stamp.
 * @returns A base64url digest, matching the Python tracker's stamp.
 */
export async function fingerprint(content: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', content as Uint8Array<ArrayBuffer>)
  return encodeBase64(new Uint8Array(digest))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

async function readBytes(vfs: Ops, path: string): Promise<Uint8Array> {
  return (await vfs.read(path, { raw: true })).slice()
}

export class FileVersionTracker {
  private readonly readVersions = new Map<string, string>()
  private readonly editVersions = new Map<string, string>()
  private readonly writes = new Map<string, number>()
  private readonly seen = new Set<string>()

  /**
   * @param vfs The file API to read and write through, run as the
   *   session whose reads are tracked.
   * @param enabled False serves every call unchecked.
   */
  constructor(
    readonly vfs: Ops,
    private readonly enabled = true,
  ) {}

  // The stamp key for a path: one key per file, not per spelling.
  // readFile and writeFile follow the namespace symlink table, so
  // `/alias` and `/target` are the same file. Keying by the caller's
  // spelling would give each its own stamp, and an edit that arrived
  // through the other name would find no prior version and skip the
  // staleness check entirely.
  private key(path: string): string {
    return this.vfs.links === null ? path : this.vfs.links.follow(path)
  }

  private async currentVersion(path: string): Promise<string | null> {
    if (!(await this.vfs.exists(path))) return null
    return fingerprint(await readBytes(this.vfs, path))
  }

  private async assertVersion(path: string, expected: string): Promise<void> {
    if ((await this.currentVersion(path)) !== expected) {
      throw new StaleMirageFileError(path)
    }
  }

  // Stamp what a later read will return, not the bytes handed in. A
  // mount that does not store writes verbatim answers with something
  // else, so stamping the input would make the very next write or edit
  // look stale with nobody having touched the file.
  private async recordWrite(path: string, key: string): Promise<void> {
    if (!this.enabled) return
    this.writes.set(key, (this.writes.get(key) ?? 0) + 1)
    const version = await this.currentVersion(path)
    if (version === null) this.readVersions.delete(key)
    else this.readVersions.set(key, version)
    this.editVersions.delete(key)
  }

  /**
   * Whether a write may overwrite the file: the agent was shown all of it,
   * or wrote all of it, since this tracker started, or nothing is checked.
   * A read of a few lines does not count, so a write never replaces lines
   * the agent did not see.
   */
  hasRead(path: string): boolean {
    return !this.enabled || this.seen.has(this.key(path))
  }

  /** Record that the agent was shown all of the file. */
  markSeen(path: string): void {
    if (this.enabled) this.seen.add(this.key(path))
  }

  // The bytes a read fetched may predate a write that lands while it is
  // in flight, so such a read fetches once more: the agent is never shown
  // bytes older than a write it already saw finish. A write that lands
  // during the second fetch too leaves the stamp of what was shown, and
  // the next write is refused as stale.
  async read(path: string): Promise<Uint8Array> {
    const key = this.key(path)
    const writes = this.writes.get(key)
    let content = await readBytes(this.vfs, path)
    if (!this.enabled) return content
    let version = await fingerprint(content)
    if (this.writes.get(key) !== writes) {
      content = await readBytes(this.vfs, path)
      version = await fingerprint(content)
    }
    this.readVersions.set(key, version)
    return content
  }

  async readForEdit(path: string): Promise<Uint8Array> {
    const content = await readBytes(this.vfs, path)
    if (!this.enabled) return content
    const key = this.key(path)
    const version = await fingerprint(content)
    const readVersion = this.readVersions.get(key)
    if (readVersion !== undefined && readVersion !== version) {
      throw new StaleMirageFileError(path)
    }
    this.editVersions.set(key, version)
    return content
  }

  async write(path: string, content: string): Promise<void> {
    const key = this.key(path)
    if (this.enabled) {
      const readVersion = this.readVersions.get(key)
      if (readVersion !== undefined) await this.assertVersion(path, readVersion)
    }
    await this.vfs.write(path, content)
    await this.recordWrite(path, key)
    if (this.enabled) this.seen.add(key)
  }

  async writeEdit(path: string, content: string): Promise<void> {
    const key = this.key(path)
    if (this.enabled) {
      const editVersion = this.editVersions.get(key)
      if (editVersion !== undefined) await this.assertVersion(path, editVersion)
    }
    await this.vfs.write(path, content)
    await this.recordWrite(path, key)
  }
}
