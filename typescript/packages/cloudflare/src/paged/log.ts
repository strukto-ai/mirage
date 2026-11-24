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

import type { DurableObjectStorageLike } from '../sql.ts'

/** The bytes one page of the database inside holds. */
export const PAGE_BYTES = 4096

const TABLE = 'mirage_page_log'
const MAGIC = 0x344c4750
// A row's head: the magic, the commit it belongs to, its part of that commit,
// its flags, how many pages it holds, the database's size in pages, then one
// page number a page.
const HEAD_BYTES = 20
const FINAL = 1
// A row cache key is the row's id and a column of it.
const KEY_COLUMNS = 128

/** How a page log is laid out and how much memory it may hold. */
export interface PageLogOptions {
  /** The most bytes of rows read back that stay in memory. */
  readonly cacheBytes?: number
  /** The most bytes of changed pages held before the oldest are written out. */
  readonly spillBytes?: number
  /** The pages one column of a row holds: what one page read brings along. */
  readonly columnPages?: number
  /** The columns of a row; with `columnPages`, the pages one row holds. */
  readonly columns?: number
  /** The emptied rows kept for the next commit to write over. */
  readonly spareRows?: number
  /** The bytes of dead pages past which a commit moves live ones out of sparse rows. */
  readonly compactBytes?: number
  /** The most bytes one commit moves out of sparse rows. */
  readonly compactStepBytes?: number
}

/** What a page log has asked of the storage under it. */
export interface PageLogCounts {
  rowsWritten: number
  rowsDeleted: number
  rowsRead: number
}

interface LogRow {
  // The pages the row was written with, and how many of them are still the
  // latest of their number.
  count: number
  live: number
}

interface ReadRun {
  end: number
  width: number
}

function bytesOf(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new Error(`${TABLE} holds a value that is not a BLOB`)
}

/**
 * A SQLite database's pages, kept in a Durable Object's own SQLite as a log of
 * the pages each commit changed.
 *
 * The object's database bills every row written, whatever its size, so a
 * commit's pages go out as rows of about 1.9 MB: thousands of rows changed
 * inside cost one or two outside. A row holds its pages a few to a column, so
 * reading one page back reads one column and not the row. A commit is whole
 * or absent: its last row carries a flag, and loading keeps what precedes the
 * latest flagged commit and deletes what follows it.
 */
export class PageLog {
  /** The database's size in pages, changes not yet committed included. */
  size = 0
  readonly counts: PageLogCounts = { rowsWritten: 0, rowsDeleted: 0, rowsRead: 0 }
  private readonly cacheBytes: number
  private readonly spillBytes: number
  private readonly columnPages: number
  private readonly columns: number
  private readonly rowPages: number
  private readonly spareRows: number
  private readonly compactBytes: number
  private readonly compactStepBytes: number
  private readonly names: string[]
  private readonly insertSql: string
  private readonly updateSql: string
  private readonly selects = new Map<number, string>()
  // The row and the slot in it that hold each page as last committed.
  private rowOf = new Int32Array(4096).fill(-1)
  private slotOf = new Int32Array(4096)
  private high = 0
  private readonly rows = new Map<number, LogRow>()
  private readonly free: number[] = []
  private readonly freed: number[] = []
  private published = 0
  // The size the database was cut to since the last commit: committed pages
  // from there on are gone, whatever was written past it since.
  private cutAt = Infinity
  private seq = 0
  private part = 0
  // The last row of the latest commit, which marks it whole: kept until the
  // next commit has one of its own.
  private finalId = -1
  private broken: Error | null = null
  // Whether pages were abandoned since the last commit.
  private abandoned = false
  private readonly spare: Uint8Array[] = []
  private nextId = 1
  private readonly dirty = new Map<number, Uint8Array>()
  // Pages written out ahead of their commit, and the rows that hold them.
  private readonly spilled = new Map<number, readonly [number, number]>()
  private readonly provisional = new Map<number, number>()
  private readonly cache = new Map<number, Uint8Array>()
  private cached = 0
  // Where each of the last few runs of reads ended and how many columns its
  // last read took: a table scanned while an index is searched is two runs.
  private readonly runs: ReadRun[] = []

  constructor(
    private readonly storage: DurableObjectStorageLike,
    options: PageLogOptions = {},
  ) {
    this.cacheBytes = options.cacheBytes ?? 8 << 20
    this.spillBytes = options.spillBytes ?? 6 << 20
    this.columnPages = options.columnPages ?? 5
    this.columns = options.columns ?? 92
    if (this.columns < 1 || this.columns >= KEY_COLUMNS || this.columnPages < 1) {
      throw new Error('a page log row takes 1 to 127 columns of at least one page')
    }
    this.rowPages = this.columnPages * this.columns
    this.spareRows = options.spareRows ?? 4
    this.compactBytes = options.compactBytes ?? 32 << 20
    this.compactStepBytes = options.compactStepBytes ?? 8 << 20
    this.names = Array.from({ length: this.columns }, (_, i) => `c${String(i)}`)
    const list = this.names.join(', ')
    this.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY, head BLOB NOT NULL, ${this.names.map((c) => `${c} BLOB`).join(', ')})`,
    )
    this.insertSql = `INSERT INTO ${TABLE} (id, head, ${list}) VALUES (?, ?, ${this.names.map(() => '?').join(', ')})`
    this.updateSql = `UPDATE ${TABLE} SET head = ?, ${this.names.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`
    this.load()
  }

  /** The bytes of pages the log's rows hold that a later commit replaced. */
  get deadBytes(): number {
    let dead = 0
    for (const row of this.rows.values()) dead += row.count - row.live
    return dead * PAGE_BYTES
  }

  /** The bytes of pages the log's rows hold, dead ones included. */
  get storedBytes(): number {
    let pages = 0
    for (const row of this.rows.values()) pages += row.count
    return pages * PAGE_BYTES
  }

  /**
   * One page as last written, or null for a page never written.
   *
   * The answer is a view of memory the log owns: it holds until the next
   * call, which may reuse it.
   */
  read(page: number): Uint8Array | null {
    if (this.broken !== null) throw this.broken
    const held = this.dirty.get(page)
    if (held !== undefined) return held
    let id: number
    let slot: number
    const spilled = this.spilled.get(page)
    if (spilled !== undefined) [id, slot] = spilled
    else {
      if (page >= this.cutAt || page >= this.rowOf.length) return null
      id = this.rowOf[page] ?? -1
      if (id < 0) return null
      slot = this.slotOf[page] ?? 0
    }
    const at = (slot % this.columnPages) * PAGE_BYTES
    return this.fetch(id, Math.floor(slot / this.columnPages)).subarray(at, at + PAGE_BYTES)
  }

  /**
   * Hold one page's new bytes until the next commit.
   *
   * A page past the database's end leaves no hole before it: the pages
   * between are written as zeros, so none of them can answer with what an
   * earlier commit held there.
   */
  write(page: number, data: Uint8Array): void {
    if (this.broken !== null) throw this.broken
    for (let hole = this.size; hole < page; hole++) this.dirty.set(hole, this.buffer().fill(0))
    let held = this.dirty.get(page)
    if (held === undefined) {
      held = this.buffer()
      this.dirty.set(page, held)
    }
    held.set(data)
    if (page >= this.size) this.size = page + 1
    if (this.dirty.size * PAGE_BYTES <= this.spillBytes) return
    try {
      this.emit(false)
    } catch (e) {
      throw this.breakWith(e)
    }
  }

  /** Cut the database to `size` pages. */
  truncate(size: number): void {
    if (size >= this.size) return
    for (const page of [...this.dirty.keys()]) if (page >= size) this.release(page)
    for (const page of [...this.spilled.keys()]) if (page >= size) this.spilled.delete(page)
    this.size = size
    this.cutAt = Math.min(this.cutAt, size)
  }

  /**
   * Store the pages named no more.
   *
   * They are pages the database reads nothing from before it writes them
   * again, as the ones SQLite has freed. One read all the same answers
   * zeros, or what a commit once held there.
   */
  abandon(pages: Iterable<number>): void {
    if (this.broken !== null) throw this.broken
    for (const page of pages) {
      if (page >= this.size || this.spilled.has(page)) continue
      this.release(page)
      this.drop(page)
    }
    this.abandoned = true
  }

  /**
   * Commit every change since the last commit, all of it or none.
   *
   * @returns the rows the commit wrote and deleted.
   * @throws what the storage threw. The log then refuses every read and
   *   write, as what it holds in memory no longer matches what is stored.
   */
  flush(): number {
    const changed = this.dirty.size > 0 || this.spilled.size > 0 || this.size !== this.published
    if (!changed && this.freed.length === 0) return 0
    if (this.broken !== null) throw this.broken
    const before = this.counts.rowsWritten + this.counts.rowsDeleted
    try {
      this.storage.transactionSync(() => {
        this.commit()
      })
    } catch (e) {
      throw this.breakWith(e)
    }
    this.published = this.size
    this.cutAt = Infinity
    this.seq++
    this.part = 0
    this.spilled.clear()
    this.provisional.clear()
    this.abandoned = false
    if (this.spare.length > 256) this.spare.length = 0
    return this.counts.rowsWritten + this.counts.rowsDeleted - before
  }

  // The storage failed while rows were being written, so what the log holds
  // in memory no longer matches what is stored: it answers nothing more.
  private breakWith(e: unknown): Error {
    this.broken = e instanceof Error ? e : new Error(String(e))
    return this.broken
  }

  private exec(sql: string, params: readonly unknown[] = []): Record<string, unknown>[] {
    return this.storage.sql.exec(sql, ...params).toArray()
  }

  private row(id: number): LogRow {
    const row = this.rows.get(id)
    if (row === undefined) throw new Error(`${TABLE} has no row ${String(id)}`)
    return row
  }

  private load(): void {
    const parsed: {
      id: number
      seq: number
      part: number
      final: boolean
      size: number
      pages: Uint32Array
    }[] = []
    for (const r of this.exec(`SELECT id, head FROM ${TABLE} ORDER BY id`)) {
      const id = Number(r.id)
      const head = bytesOf(r.head)
      const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
      if (head.byteLength < HEAD_BYTES || view.getUint32(0, true) !== MAGIC) {
        throw new Error(`${TABLE} row ${String(id)} is not a page log row`)
      }
      this.nextId = Math.max(this.nextId, id + 1)
      const count = view.getUint32(12, true)
      const pages = new Uint32Array(count)
      for (let i = 0; i < count; i++) pages[i] = view.getUint32(HEAD_BYTES + 4 * i, true)
      parsed.push({
        id,
        seq: view.getUint32(4, true),
        part: view.getUint16(8, true),
        final: (view.getUint16(10, true) & FINAL) !== 0,
        size: view.getUint32(16, true),
        pages,
      })
    }
    // Commits follow one another, each whole or absent, and a commit's last
    // row may since have been written over. So every row up to the latest
    // commit that still has its last row belongs to a whole commit, and the
    // rows after it are what a commit cut short wrote ahead.
    let latest = 0
    for (const p of parsed) if (p.final && p.seq > latest) latest = p.seq
    parsed.sort((a, b) => a.seq - b.seq || a.part - b.part)
    for (const p of parsed) {
      if (p.seq > latest) {
        this.exec(`DELETE FROM ${TABLE} WHERE id = ?`, [p.id])
        this.counts.rowsDeleted++
        continue
      }
      this.rows.set(p.id, { count: p.pages.length, live: 0 })
      p.pages.forEach((page, slot) => {
        this.place(page, p.id, slot)
      })
      if (p.final) {
        this.cut(p.size)
        this.size = p.size
        this.finalId = p.id
      }
    }
    this.seq = latest
    this.published = this.size
    this.freed.length = 0
    for (const [id, row] of this.rows) if (row.live === 0 && id !== this.finalId) this.free.push(id)
  }

  private grow(page: number): void {
    if (page < this.rowOf.length) return
    let n = this.rowOf.length
    while (n <= page) n *= 2
    const rowOf = new Int32Array(n).fill(-1)
    rowOf.set(this.rowOf)
    const slotOf = new Int32Array(n)
    slotOf.set(this.slotOf)
    this.rowOf = rowOf
    this.slotOf = slotOf
  }

  private drop(page: number): void {
    const old = this.rowOf[page] ?? -1
    if (old < 0) return
    if (--this.row(old).live === 0) this.freed.push(old)
    this.rowOf[page] = -1
  }

  private place(page: number, row: number, slot: number): void {
    this.grow(page)
    this.drop(page)
    this.rowOf[page] = row
    this.slotOf[page] = slot
    this.row(row).live++
    if (page >= this.high) this.high = page + 1
  }

  private cut(size: number): void {
    for (let page = size; page < this.high; page++) this.drop(page)
    if (size < this.high) this.high = size
  }

  private keep(key: number, blob: Uint8Array): void {
    this.cache.set(key, blob)
    this.cached += blob.byteLength
    for (const [old, held] of this.cache) {
      if (this.cached <= this.cacheBytes || old === key) break
      this.cache.delete(old)
      this.cached -= held.byteLength
    }
  }

  private forget(id: number): void {
    for (let column = 0; column < this.columns; column++) {
      const key = id * KEY_COLUMNS + column
      const held = this.cache.get(key)
      if (held === undefined) continue
      this.cache.delete(key)
      this.cached -= held.byteLength
    }
  }

  // One column of a row: the pages of slots `column * columnPages` onward.
  private fetch(id: number, column: number): Uint8Array {
    const key = id * KEY_COLUMNS + column
    const held = this.cache.get(key)
    if (held !== undefined) {
      this.cache.delete(key)
      this.cache.set(key, held)
      return held
    }
    // The storage walks a row's bytes up to the column asked for, so a read
    // that carries on where an earlier one ended takes twice as many columns
    // as that one did, up to the row's end. A scan skips a little as it goes,
    // so a read just past a run's end still carries it on.
    const pages = this.provisional.get(id) ?? this.row(id).count
    const inRow = Math.ceil(pages / this.columnPages)
    const at = this.runs.findIndex((r) => key > r.end && key - r.end <= Math.max(4, r.width))
    const run = this.runs.splice(at, at < 0 ? 0 : 1)[0] ?? { end: 0, width: 0 }
    let width = at < 0 ? 1 : Math.min(Math.max(run.width, 1) * 2, this.columns)
    width = Math.max(1, Math.min(width, inRow - column))
    for (let k = 1; k < width; k++) {
      if (this.cache.has(key + k)) {
        width = k
        break
      }
    }
    const names = this.names.slice(column, column + width)
    const sqlKey = column * KEY_COLUMNS + width
    let sql = this.selects.get(sqlKey)
    if (sql === undefined) {
      sql = `SELECT ${names.join(', ')} FROM ${TABLE} WHERE id = ?`
      this.selects.set(sqlKey, sql)
    }
    const got = this.exec(sql, [id])[0]
    if (got === undefined) throw new Error(`${TABLE} has no row ${String(id)}`)
    this.counts.rowsRead++
    const pieces = names.map((name) => bytesOf(got[name]))
    for (let k = width - 1; k >= 0; k--) {
      const piece = pieces[k]
      if (piece !== undefined) this.keep(key + k, piece)
    }
    run.end = key + width - 1
    run.width = width
    this.runs.push(run)
    if (this.runs.length > 8) this.runs.shift()
    const first = pieces[0]
    if (first === undefined) throw new Error(`${TABLE} row ${String(id)} lacks a column`)
    return first
  }

  private buffer(): Uint8Array {
    const spare = this.spare.pop()
    if (spare !== undefined) return spare
    const slab = new Uint8Array(PAGE_BYTES * 64)
    for (let i = 1; i < 64; i++) {
      this.spare.push(slab.subarray(i * PAGE_BYTES, (i + 1) * PAGE_BYTES))
    }
    return slab.subarray(0, PAGE_BYTES)
  }

  private release(page: number): void {
    const held = this.dirty.get(page)
    if (held === undefined) return
    this.dirty.delete(page)
    this.spare.push(held)
  }

  private put(id: number, head: Uint8Array, columns: readonly (Uint8Array | null)[]): void {
    const blobs = columns.map((column) => column?.buffer ?? null)
    if (this.rows.has(id)) this.exec(this.updateSql, [head.buffer, ...blobs, id])
    else {
      this.exec(this.insertSql, [id, head.buffer, ...blobs])
      this.rows.set(id, { count: 0, live: 0 })
    }
    this.forget(id)
    columns.forEach((column, i) => {
      if (column !== null) this.keep(id * KEY_COLUMNS + i, column)
    })
    this.counts.rowsWritten++
  }

  // Write changed pages out as rows: every one of them when `final`, whole
  // rows of them otherwise. They go in the order they were first changed, so
  // what was written together is read back together however the database
  // numbers its pages.
  private emit(final: boolean): number {
    const pages = [...this.dirty.keys()]
    let done = 0
    let last = -1
    do {
      if (!final && pages.length - done < this.rowPages) break
      const chunk = pages.slice(done, done + this.rowPages)
      done += chunk.length
      const id = this.free.pop() ?? this.nextId++
      const head = new Uint8Array(HEAD_BYTES + 4 * chunk.length)
      const view = new DataView(head.buffer)
      view.setUint32(0, MAGIC, true)
      view.setUint32(4, this.seq + 1, true)
      view.setUint16(8, this.part++, true)
      view.setUint16(10, final && done >= pages.length ? FINAL : 0, true)
      view.setUint32(12, chunk.length, true)
      view.setUint32(16, this.size, true)
      const columns = new Array<Uint8Array | null>(this.columns).fill(null)
      chunk.forEach((page, slot) => {
        view.setUint32(HEAD_BYTES + 4 * slot, page, true)
        const index = Math.floor(slot / this.columnPages)
        let column = columns[index] ?? null
        if (column === null) {
          const held = Math.min(this.columnPages, chunk.length - index * this.columnPages)
          column = new Uint8Array(held * PAGE_BYTES)
          columns[index] = column
        }
        const bytes = this.dirty.get(page)
        if (bytes !== undefined) column.set(bytes, (slot % this.columnPages) * PAGE_BYTES)
        this.spilled.set(page, [id, slot])
      })
      this.put(id, head, columns)
      this.provisional.set(id, chunk.length)
      last = id
    } while (done < pages.length)
    for (const page of pages.slice(0, done)) this.release(page)
    return last
  }

  // Once dead pages outweigh half the live ones, the live pages of the
  // sparsest rows join the commit, which empties those rows for reuse.
  private compact(): void {
    const dead = this.deadBytes
    if (dead < this.compactBytes || dead < (this.storedBytes - dead) / 2) return
    const sparse = [...this.rows]
      .filter(([, row]) => row.live > 0 && row.live * 2 < row.count)
      .sort(([, a], [, b]) => a.live / a.count - b.live / b.count)
    let moved = 0
    for (const [id, row] of sparse) {
      if (moved >= this.compactStepBytes) break
      const stored = this.exec(`SELECT head FROM ${TABLE} WHERE id = ?`, [id])[0]
      if (stored === undefined) throw new Error(`${TABLE} has no row ${String(id)}`)
      const head = bytesOf(stored.head)
      const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
      for (let slot = 0; slot < row.count; slot++) {
        const page = view.getUint32(HEAD_BYTES + 4 * slot, true)
        if (page >= this.size || page >= this.cutAt) continue
        if (this.rowOf[page] !== id || this.slotOf[page] !== slot) continue
        if (this.dirty.has(page) || this.spilled.has(page)) continue
        const at = (slot % this.columnPages) * PAGE_BYTES
        const held = this.buffer()
        held.set(this.fetch(id, Math.floor(slot / this.columnPages)).subarray(at, at + PAGE_BYTES))
        this.dirty.set(page, held)
        moved += PAGE_BYTES
      }
    }
  }

  private commit(): void {
    // A commit that abandons pages frees room, and may not want room of its
    // own to do it: the pages it would move wait for the next commit, which
    // has the rows this one empties to write into.
    if (!this.abandoned) this.compact()
    const before = this.finalId
    this.finalId = this.emit(true)
    for (const [id, count] of this.provisional) this.rows.set(id, { count, live: 0 })
    for (let page = this.cutAt; page < this.high; page++) {
      if (!this.spilled.has(page)) this.drop(page)
    }
    for (const [page, [id, slot]] of this.spilled) this.place(page, id, slot)
    this.cut(this.size)
    for (const id of this.provisional.keys()) if (this.row(id).live === 0) this.freed.push(id)
    // The commit before has its successor now, so its last row is free once
    // nothing lives in it.
    if (before >= 0 && this.rows.get(before)?.live === 0) this.freed.push(before)
    const freed = new Set(this.freed)
    freed.delete(this.finalId)
    for (const id of freed) if (!this.free.includes(id)) this.free.push(id)
    this.freed.length = 0
    while (this.free.length > this.spareRows) {
      const id = this.free.shift()
      if (id === undefined) break
      this.exec(`DELETE FROM ${TABLE} WHERE id = ?`, [id])
      this.rows.delete(id)
      this.forget(id)
      this.counts.rowsDeleted++
    }
  }
}
