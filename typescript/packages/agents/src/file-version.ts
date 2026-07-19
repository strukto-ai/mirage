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
import type { Workspace } from '@struktoai/mirage-core'

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

export class FileVersionTracker {
  private readonly readVersions = new Map<string, string>()
  private readonly editVersions = new Map<string, string>()

  constructor(
    private readonly ws: Workspace,
    private readonly enabled = true,
  ) {}

  private async currentVersion(path: string): Promise<string | null> {
    if (!(await this.ws.fs.exists(path))) return null
    return fingerprint(await readBuffer(this.ws, path))
  }

  private async assertVersion(path: string, expected: string): Promise<void> {
    if ((await this.currentVersion(path)) !== expected) {
      throw new StaleMirageFileError(path)
    }
  }

  private recordWrite(path: string, content: string): void {
    if (!this.enabled) return
    this.readVersions.set(path, fingerprint(content))
    this.editVersions.delete(path)
  }

  async read(path: string): Promise<Buffer> {
    const content = await readBuffer(this.ws, path)
    if (this.enabled) this.readVersions.set(path, fingerprint(content))
    return content
  }

  async readForEdit(path: string): Promise<Buffer> {
    const content = await readBuffer(this.ws, path)
    if (!this.enabled) return content
    const version = fingerprint(content)
    const readVersion = this.readVersions.get(path)
    if (readVersion !== undefined && readVersion !== version) {
      throw new StaleMirageFileError(path)
    }
    this.editVersions.set(path, version)
    return content
  }

  async write(path: string, content: string): Promise<void> {
    if (this.enabled) {
      const readVersion = this.readVersions.get(path)
      if (readVersion !== undefined) await this.assertVersion(path, readVersion)
    }
    await this.ws.fs.writeFile(path, content)
    this.recordWrite(path, content)
  }

  async writeEdit(path: string, content: string): Promise<void> {
    if (this.enabled) {
      const editVersion = this.editVersions.get(path)
      if (editVersion !== undefined) await this.assertVersion(path, editVersion)
    }
    await this.ws.fs.writeFile(path, content)
    this.recordWrite(path, content)
  }
}
