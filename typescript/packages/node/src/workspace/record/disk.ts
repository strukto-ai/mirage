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

import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { generationOf } from '@struktoai/mirage-core/workspace/record/types'

// A .lock older than this is presumed abandoned by a crashed writer and
// reclaimed (loudly). Live CAS critical sections are milliseconds.
const LOCK_STALE_SECONDS = 10
const LOCK_RETRY_SLEEP_MS = 5
const LOCK_RETRY_LIMIT = 2000

let tmpCounter = 0

// Match Python's urllib quote(safe=""): percent-encode everything
// outside the unreserved set, so both runtimes produce byte-identical
// filenames over one shared state directory.
export function quoteName(name: string): string {
  return encodeURIComponent(name).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * One JSON-record-per-file client with lockfile CAS.
 *
 * The disk twin of `S3RecordClient`: a record is one file at
 * `{root}/{prefix}{name}.json`, written atomically (tmp then rename(2))
 * so readers never see a torn record. The conditional write serializes
 * on a `{record}.lock` created with O_CREAT|O_EXCL, so compare and
 * write hit the same stored version. Record names are percent-encoded
 * into filenames, so any id is safe. Mirrors the Python
 * DiskRecordClient byte-for-byte on disk.
 */
export class DiskRecordClient {
  private readonly dir: string

  constructor(root: string, prefix: string) {
    this.dir = path.join(root, prefix)
  }

  path(name: string): string {
    return path.join(this.dir, `${quoteName(name)}.json`)
  }

  // The token slot mirrors the S3 client's ETag but stays empty: disk
  // CAS anchors on the lockfile, not on a version token.
  async get(name: string): Promise<[Record<string, unknown> | null, string]> {
    let body: Buffer
    try {
      body = await readFile(this.path(name))
    } catch (e) {
      if (isMissing(e)) return [null, '']
      throw e
    }
    return [JSON.parse(body.toString()) as Record<string, unknown>, '']
  }

  async put(name: string, fields: Record<string, unknown>): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await this.writeRecord(this.path(name), fields)
  }

  /**
   * Write one record iff its stored generation matches.
   *
   * Take the record's lockfile, re-read under the lock, check the
   * generation, then tmp-write + rename. Losing the lock race or the
   * generation check resolves false; the caller adopts and retries.
   */
  async casPut(
    name: string,
    fields: Record<string, unknown>,
    expectedGeneration: number,
  ): Promise<boolean> {
    await mkdir(this.dir, { recursive: true })
    const target = this.path(name)
    const lockPath = `${target}.lock`
    let fh = await this.acquireLock(lockPath)
    if (fh === null) {
      if (!(await this.reclaimStaleLock(lockPath))) return false
      fh = await this.acquireLock(lockPath)
      if (fh === null) return false
    }
    try {
      const [stored] = await this.get(name)
      if (generationOf(stored) !== expectedGeneration) return false
      await this.writeRecord(target, fields)
      return true
    } finally {
      await this.releaseLock(fh, lockPath)
    }
  }

  async listNames(): Promise<string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch (e) {
      if (isMissing(e)) return []
      throw e
    }
    return entries
      .filter((n) => n.endsWith('.json'))
      .map((n) => decodeURIComponent(n.slice(0, -'.json'.length)))
  }

  async delete(names: Iterable<string>): Promise<void> {
    for (const name of names) {
      try {
        await unlink(this.path(name))
      } catch (e) {
        // Delete promises absence; already-absent is success.
        if (!isMissing(e)) throw e
      }
    }
  }

  async clear(): Promise<void> {
    await this.delete(await this.listNames())
  }

  async close(): Promise<void> {
    // Nothing held open between calls.
  }

  /**
   * Block until this record's lockfile is held; handle to release.
   *
   * For callers doing a read-modify-write that is not generation-CAS
   * (e.g. the single-file namespace plane); spins past contention and
   * reclaims stale locks, throwing only if a live writer holds the
   * lock for the whole retry budget (~10s).
   */
  async lock(name: string): Promise<FileHandle> {
    await mkdir(this.dir, { recursive: true })
    const lockPath = `${this.path(name)}.lock`
    for (let i = 0; i < LOCK_RETRY_LIMIT; i++) {
      const fh = await this.acquireLock(lockPath)
      if (fh !== null) return fh
      if (await this.reclaimStaleLock(lockPath)) continue
      await new Promise((r) => setTimeout(r, LOCK_RETRY_SLEEP_MS))
    }
    throw new Error(`could not acquire lock ${lockPath}`)
  }

  async unlock(name: string, fh: FileHandle): Promise<void> {
    await this.releaseLock(fh, `${this.path(name)}.lock`)
  }

  // O_CREAT|O_EXCL ('wx'): filesystem-atomic mutex, the git protocol.
  // Local filesystems only (O_EXCL is unreliable on ancient NFS, the
  // same caveat git ships with).
  private async acquireLock(lockPath: string): Promise<FileHandle | null> {
    let fh: FileHandle
    try {
      fh = await open(lockPath, 'wx')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw e
    }
    try {
      await fh.write(String(process.pid))
      return fh
    } catch (error) {
      await this.releaseLock(fh, lockPath)
      throw error
    }
  }

  // True when the lock is gone or was stale and removed; false when a
  // live writer still holds it or another waiter is reclaiming it.
  // Reclaimers serialize on a `.reclaim` guard, itself reclaimed the
  // same way, and re-check the age under it: no waiter creates a lock
  // while the stale one exists, so the lock found stale is the one
  // removed, never a fresh lock another reclaimer just took.
  private async reclaimStaleLock(lockPath: string): Promise<boolean> {
    const age = async (): Promise<number | null> => {
      try {
        return (Date.now() - (await stat(lockPath)).mtimeMs) / 1000
      } catch (e) {
        if (isMissing(e)) return null
        throw e
      }
    }
    let seen = await age()
    if (seen === null) return true
    if (seen <= LOCK_STALE_SECONDS) return false
    const guard = `${lockPath}.reclaim`
    try {
      await (await open(guard, 'wx')).close()
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      await this.reclaimStaleLock(guard)
      return false
    }
    try {
      seen = await age()
      if (seen === null) return true
      if (seen <= LOCK_STALE_SECONDS) return false
      console.warn(`mirage: reclaiming stale lock ${lockPath} (age ${seen.toFixed(1)}s)`)
      try {
        await unlink(lockPath)
      } catch (e) {
        // The holder released it between the stat and the unlink; the
        // lock is gone either way, which is all this method promises.
        if (!isMissing(e)) throw e
      }
      return true
    } finally {
      await unlink(guard)
    }
  }

  private async releaseLock(fh: FileHandle, lockPath: string): Promise<void> {
    let owned = false
    try {
      const held = await fh.stat({ bigint: true })
      const current = await stat(lockPath, { bigint: true })
      owned = held.dev === current.dev && held.ino === current.ino
      if (owned) await unlink(lockPath)
    } catch (e) {
      if (!isMissing(e)) throw e
      owned = false
    } finally {
      await fh.close()
    }
    // Only reachable when another writer reclaimed this lock as stale;
    // the record write already landed, nothing to undo.
    if (!owned) console.warn(`mirage: lock ${lockPath} was reclaimed before release`)
  }

  private async writeRecord(target: string, fields: Record<string, unknown>): Promise<void> {
    const tmp = `${target}.${String(process.pid)}.${String(tmpCounter++)}.tmp`
    const fh = await open(tmp, 'w')
    try {
      await fh.writeFile(JSON.stringify(fields))
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, target)
  }
}
