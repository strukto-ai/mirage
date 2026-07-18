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

import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { generationOf, SessionStore, type SessionFields } from '@struktoai/mirage-core'

// A .lock older than this is presumed abandoned by a crashed writer and
// reclaimed (loudly). Live CAS critical sections are milliseconds.
const LOCK_STALE_SECONDS = 10
const LOCK_RETRY_SLEEP_MS = 5
const LOCK_RETRY_LIMIT = 2000

let tmpCounter = 0

// Match Python's urllib quote(safe=""): percent-encode everything
// outside the unreserved set, so both runtimes produce byte-identical
// filenames over one shared state directory.
function quoteName(name: string): string {
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

  recordPath(name: string): string {
    return path.join(this.dir, `${quoteName(name)}.json`)
  }

  // The token slot mirrors the S3 client's ETag but stays empty: disk
  // CAS anchors on the lockfile, not on a version token.
  async get(name: string): Promise<[Record<string, unknown> | null, string]> {
    let body: Buffer
    try {
      body = await readFile(this.recordPath(name))
    } catch (e) {
      if (isMissing(e)) return [null, '']
      throw e
    }
    return [JSON.parse(body.toString()) as Record<string, unknown>, '']
  }

  async put(name: string, fields: Record<string, unknown>): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await this.writeRecord(this.recordPath(name), fields)
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
    const target = this.recordPath(name)
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

  async loadAll(): Promise<Map<string, Record<string, unknown>>> {
    const names = await this.listNames()
    const records = await Promise.all(names.map((name) => this.get(name)))
    const out = new Map<string, Record<string, unknown>>()
    for (let i = 0; i < names.length; i++) {
      const name = names[i]
      const fields = records[i]?.[0]
      if (name !== undefined && fields != null) out.set(name, fields)
    }
    return out
  }

  async delete(names: Iterable<string>): Promise<void> {
    for (const name of names) {
      try {
        await unlink(this.recordPath(name))
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
    const lockPath = `${this.recordPath(name)}.lock`
    for (let i = 0; i < LOCK_RETRY_LIMIT; i++) {
      const fh = await this.acquireLock(lockPath)
      if (fh !== null) return fh
      if (await this.reclaimStaleLock(lockPath)) continue
      await new Promise((r) => setTimeout(r, LOCK_RETRY_SLEEP_MS))
    }
    throw new Error(`could not acquire lock ${lockPath}`)
  }

  async unlock(name: string, fh: FileHandle): Promise<void> {
    await this.releaseLock(fh, `${this.recordPath(name)}.lock`)
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
    await fh.write(String(process.pid))
    return fh
  }

  // True when the lock is gone or was stale and removed; false when a
  // live writer still holds it.
  private async reclaimStaleLock(lockPath: string): Promise<boolean> {
    let mtimeMs: number
    try {
      mtimeMs = (await stat(lockPath)).mtimeMs
    } catch (e) {
      if (isMissing(e)) return true
      throw e
    }
    const age = (Date.now() - mtimeMs) / 1000
    if (age <= LOCK_STALE_SECONDS) return false
    console.warn(`mirage: reclaiming stale lock ${lockPath} (age ${age.toFixed(1)}s)`)
    try {
      await unlink(lockPath)
    } catch (e) {
      // The holder released it between the stat and the unlink; the
      // lock is gone either way, which is all this method promises.
      if (!isMissing(e)) throw e
    }
    return true
  }

  private async releaseLock(fh: FileHandle, lockPath: string): Promise<void> {
    await fh.close()
    try {
      await unlink(lockPath)
    } catch (e) {
      // Only reachable when another writer reclaimed this lock as
      // stale; the record write already landed, nothing to undo.
      if (!isMissing(e)) throw e
      console.warn(`mirage: lock ${lockPath} vanished before release (reclaimed?)`)
    }
  }

  private async writeRecord(target: string, fields: Record<string, unknown>): Promise<void> {
    const tmp = `${target}.${String(process.pid)}.${String(tmpCounter++)}.tmp`
    await writeFile(tmp, JSON.stringify(fields))
    await rename(tmp, target)
  }
}

/**
 * SessionStore backed by per-session files under one directory.
 *
 * One file per session at `{root}/sessions/{session_id}.json`, lockfile
 * CAS per record, so multiple local processes share one session table
 * with the same generation contract as the Redis Lua script, with zero
 * infrastructure. Mirrors the Python DiskSessionStore.
 */
export class DiskSessionStore extends SessionStore {
  private readonly records: DiskRecordClient

  constructor(root: string) {
    super()
    this.records = new DiskRecordClient(root, 'sessions/')
  }

  async load(): Promise<Map<string, SessionFields>> {
    return await this.records.loadAll()
  }

  async set(sessionId: string, fields: SessionFields): Promise<void> {
    await this.records.put(sessionId, fields)
  }

  async casSet(
    sessionId: string,
    fields: SessionFields,
    expectedGeneration: number,
  ): Promise<boolean> {
    return await this.records.casPut(sessionId, fields, expectedGeneration)
  }

  async delete(sessionIds: readonly string[]): Promise<void> {
    await this.records.delete(sessionIds)
  }

  async replaceAll(entries: Map<string, SessionFields>): Promise<void> {
    const stale = (await this.records.listNames()).filter((n) => !entries.has(n))
    await this.records.delete(stale)
    await Promise.all([...entries].map(([sid, fields]) => this.records.put(sid, fields)))
  }

  async clear(): Promise<void> {
    await this.records.clear()
  }

  async close(): Promise<void> {
    await this.records.close()
  }
}
