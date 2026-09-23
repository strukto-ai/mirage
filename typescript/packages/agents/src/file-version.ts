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
  const bytes = await ws.vfs.readFile(path, { raw: true })
  return Buffer.from(bytes)
}

export class FileVersionTracker {
  private readonly readVersions = new Map<string, string>()
  private readonly editVersions = new Map<string, string>()

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

  private async currentVersion(path: string): Promise<string | null> {
    if (!(await this.ws.vfs.exists(path))) return null
    return fingerprint(await readBuffer(this.ws, path))
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
    const version = await this.currentVersion(path)
    if (version === null) this.readVersions.delete(key)
    else this.readVersions.set(key, version)
    this.editVersions.delete(key)
  }

  async read(path: string): Promise<Buffer> {
    const content = await readBuffer(this.ws, path)
    if (this.enabled) this.readVersions.set(this.key(path), fingerprint(content))
    return content
  }

  async readForEdit(path: string): Promise<Buffer> {
    const content = await readBuffer(this.ws, path)
    if (!this.enabled) return content
    const key = this.key(path)
    const version = fingerprint(content)
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
    await this.ws.vfs.writeFile(path, content)
    await this.recordWrite(path, key)
  }

  async writeEdit(path: string, content: string): Promise<void> {
    const key = this.key(path)
    if (this.enabled) {
      const editVersion = this.editVersions.get(key)
      if (editVersion !== undefined) await this.assertVersion(path, editVersion)
    }
    await this.ws.vfs.writeFile(path, content)
    await this.recordWrite(path, key)
  }
}
