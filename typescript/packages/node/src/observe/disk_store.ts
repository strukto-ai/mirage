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

import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { ObserverStoreBase } from '@struktoai/mirage-core'

/**
 * ObserverStore backed by a directory of JSONL files. Created lazily on
 * first append. Mirrors the Python DiskObserverStore.
 */
export class DiskObserverStore extends ObserverStoreBase {
  private readonly root: string

  constructor(root: string) {
    super()
    this.root = root
  }

  private abs(key: string): string {
    return path.join(this.root, key.replace(/^\/+/, ''))
  }

  async append(key: string, data: Uint8Array): Promise<void> {
    const absPath = this.abs(key)
    await mkdir(path.dirname(absPath), { recursive: true })
    await appendFile(absPath, data)
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    const absPath = this.abs(key)
    await mkdir(path.dirname(absPath), { recursive: true })
    await writeFile(absPath, data)
  }

  async readMatching(suffix: string): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>()
    const { files } = await this.walk()
    for (const absPath of files) {
      const rel = '/' + path.relative(this.root, absPath)
      if (!rel.endsWith(suffix)) continue
      out.set(rel, new Uint8Array(await readFile(absPath)))
    }
    return out
  }

  async clear(): Promise<void> {
    const { files, dirs } = await this.walk()
    for (const absPath of files) await unlink(absPath)
    for (const d of [...dirs].reverse()) await rmdir(d)
  }

  private async rootIsDir(): Promise<boolean> {
    try {
      return (await stat(this.root)).isDirectory()
    } catch (err) {
      // Nothing recorded yet is the normal state before the first
      // append; anything else (EACCES, EIO) is a real fault and must
      // not read as an empty history.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }

  private async walk(): Promise<{ files: string[]; dirs: string[] }> {
    const files: string[] = []
    const dirs: string[] = []
    if (!(await this.rootIsDir())) return { files, dirs }
    const stack: string[] = [this.root]
    while (stack.length > 0) {
      const d = stack.pop()
      if (d === undefined) break
      // Deliberately unguarded: a readdir that fails mid-tree used to
      // be swallowed, so readAll/readMatching returned a silently
      // partial recording and clear() reported success while leaving
      // files behind.
      const entries = await readdir(d, { withFileTypes: true })
      dirs.push(d)
      for (const entry of entries) {
        const full = path.join(d, entry.name)
        if (entry.isDirectory()) stack.push(full)
        else files.push(full)
      }
    }
    return { files, dirs }
  }
}
