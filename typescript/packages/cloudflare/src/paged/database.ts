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

import type { SqlRow, SqlValue } from '@struktoai/mirage-core/vfs/sql/types'
import * as SQLite from 'wa-sqlite'
import createModule from 'wa-sqlite/dist/wa-sqlite.mjs'
import type { DurableObjectStorageLike } from '../sql.ts'
import { PAGE_BYTES, PageLog, type PageLogOptions } from './log.ts'

const VFS_NAME = 'mirage-paged'
const MAIN = 'main.db'
const STATEMENTS = 256
const INTEGER = 1
const FLOAT = 2
const TEXT = 3
const BLOB = 4
const encoder = new TextEncoder()
const decoder = new TextDecoder()

// Whether a script has no statement left in `rest`: blanks, semicolons and
// comments may follow its last one.
function ends(rest: string): boolean {
  let at = 0
  while (at < rest.length) {
    if (rest.startsWith('--', at)) {
      const line = rest.indexOf('\n', at)
      if (line < 0) return true
      at = line + 1
    } else if (rest.startsWith('/*', at)) {
      const close = rest.indexOf('*/', at + 2)
      if (close < 0) return true
      at = close + 2
    } else if (' \t\n\f\r;'.includes(rest.charAt(at))) at += 1
    else return false
  }
  return true
}

/** How a paged database is opened. */
export interface PagedDatabaseOptions extends PageLogOptions {
  /** The most bytes of pages SQLite itself keeps in memory. */
  readonly pageCacheBytes?: number
}

type Call<T> = (...args: number[]) => T

// What the SQLite build offers beside its C functions.
interface SqliteModule {
  readonly HEAPU8: Uint8Array
  _malloc(size: number): number
  _sqlite3_malloc(size: number): number
  _sqlite3_free(at: number): void
  _getSqliteFree(): number
  getValue(at: number, type: string): number
  getTempRet0(): number
  cwrap(name: string, returns: string, args: readonly string[]): Call<unknown>
}

// A journal or a temporary file: SQLite's own, never the database.
interface MemoryFile {
  readonly key: string
  readonly flags: number
  data: Uint8Array
  size: number
}

/**
 * SQLite's file calls for one database, its pages kept in a page log.
 *
 * One connection holds the database, so its locks are always granted.
 */
class PagedVFS implements SQLiteVFS {
  readonly name = VFS_NAME
  /** What the page log last threw inside a file call. */
  failure: Error | null = null
  // The open files by SQLite's id for them; the database's own is null.
  private readonly files = new Map<number, MemoryFile | null>()
  private readonly memory = new Map<string, MemoryFile>()

  constructor(private readonly log: PageLog) {}

  xOpen(name: string | null, fileId: number, flags: number, pOutFlags: DataView): number {
    if ((flags & SQLite.SQLITE_OPEN_MAIN_DB) !== 0) {
      // The page log is one database's: another file, or the same one opened
      // again, would write over its pages.
      if (name !== MAIN || [...this.files.values()].includes(null)) return SQLite.SQLITE_CANTOPEN
      this.files.set(fileId, null)
    } else {
      const key = name ?? `temp-${String(fileId)}`
      let file = this.memory.get(key)
      if (file === undefined) {
        if ((flags & SQLite.SQLITE_OPEN_CREATE) === 0) return SQLite.SQLITE_CANTOPEN
        file = { key, flags, data: new Uint8Array(0), size: 0 }
        this.memory.set(key, file)
      }
      this.files.set(fileId, file)
    }
    pOutFlags.setInt32(0, flags, true)
    return SQLite.SQLITE_OK
  }

  xClose(fileId: number): number {
    const file = this.files.get(fileId)
    this.files.delete(fileId)
    if (file !== undefined && file !== null) {
      if ((file.flags & SQLite.SQLITE_OPEN_DELETEONCLOSE) !== 0) this.memory.delete(file.key)
    }
    return SQLite.SQLITE_OK
  }

  xRead(fileId: number, pData: Uint8Array, iOffset: number): number {
    const file = this.files.get(fileId)
    if (file === undefined) return SQLite.SQLITE_IOERR
    if (file === null) return this.guarded(() => this.readPages(pData, iOffset))
    const wanted = pData.byteLength
    const end = Math.min(iOffset + wanted, file.size)
    const got = Math.max(end - iOffset, 0)
    if (got > 0) pData.set(file.data.subarray(iOffset, end))
    if (got === wanted) return SQLite.SQLITE_OK
    pData.fill(0, got)
    return SQLite.SQLITE_IOERR_SHORT_READ
  }

  xWrite(fileId: number, pData: Uint8Array, iOffset: number): number {
    const file = this.files.get(fileId)
    if (file === undefined) return SQLite.SQLITE_IOERR
    if (file === null) return this.guarded(() => this.writePages(pData, iOffset))
    const given = pData.byteLength
    if (iOffset + given > file.data.byteLength) {
      const data = new Uint8Array(Math.max(iOffset + given, 2 * file.data.byteLength))
      data.set(file.data.subarray(0, file.size))
      file.data = data
    }
    file.data.set(pData, iOffset)
    file.size = Math.max(file.size, iOffset + given)
    return SQLite.SQLITE_OK
  }

  xTruncate(fileId: number, iSize: number): number {
    const file = this.files.get(fileId)
    if (file === undefined) return SQLite.SQLITE_IOERR
    if (file !== null) file.size = Math.min(file.size, iSize)
    else this.log.truncate(Math.ceil(iSize / PAGE_BYTES))
    return SQLite.SQLITE_OK
  }

  xSync(): number {
    return SQLite.SQLITE_OK
  }

  xLock(): number {
    return SQLite.SQLITE_OK
  }

  xUnlock(): number {
    return SQLite.SQLITE_OK
  }

  xCheckReservedLock(_fileId: number, pResOut: DataView): number {
    pResOut.setInt32(0, 0, true)
    return SQLite.SQLITE_OK
  }

  xFileSize(fileId: number, pSize64: DataView): number {
    const file = this.files.get(fileId)
    if (file === undefined) return SQLite.SQLITE_IOERR
    pSize64.setBigInt64(0, BigInt(file !== null ? file.size : this.log.size * PAGE_BYTES), true)
    return SQLite.SQLITE_OK
  }

  xSectorSize(): number {
    return PAGE_BYTES
  }

  xDeviceCharacteristics(): number {
    return 0
  }

  xFileControl(): number {
    return SQLite.SQLITE_NOTFOUND
  }

  xAccess(name: string, _flags: number, pResOut: DataView): number {
    const there = this.memory.has(name) || (name === MAIN && this.log.size > 0)
    pResOut.setInt32(0, there ? 1 : 0, true)
    return SQLite.SQLITE_OK
  }

  xDelete(name: string): number {
    this.memory.delete(name)
    return SQLite.SQLITE_OK
  }

  // What the page log throws must not unwind SQLite's own frames: SQLite
  // takes an I/O error and runs its error path, and the statement's failure
  // carries what was thrown.
  private guarded(call: () => number): number {
    try {
      return call()
    } catch (e) {
      this.failure = e instanceof Error ? e : new Error(String(e))
      return SQLite.SQLITE_IOERR
    }
  }

  private readPages(pData: Uint8Array, iOffset: number): number {
    const wanted = pData.byteLength
    const size = this.log.size * PAGE_BYTES
    let done = 0
    while (done < wanted) {
      const at = iOffset + done
      if (at >= size) {
        pData.fill(0, done)
        return SQLite.SQLITE_IOERR_SHORT_READ
      }
      const inside = at % PAGE_BYTES
      const take = Math.min(PAGE_BYTES - inside, wanted - done)
      const page = this.log.read((at - inside) / PAGE_BYTES)
      if (page === null) pData.fill(0, done, done + take)
      else pData.set(page.subarray(inside, inside + take), done)
      done += take
    }
    return SQLite.SQLITE_OK
  }

  private writePages(pData: Uint8Array, iOffset: number): number {
    const given = pData.byteLength
    let done = 0
    while (done < given) {
      const at = iOffset + done
      const inside = at % PAGE_BYTES
      const take = Math.min(PAGE_BYTES - inside, given - done)
      const index = (at - inside) / PAGE_BYTES
      if (take === PAGE_BYTES) this.log.write(index, pData.subarray(done, done + PAGE_BYTES))
      else {
        const whole = new Uint8Array(PAGE_BYTES)
        const old = this.log.read(index)
        if (old !== null) whole.set(old)
        whole.set(pData.subarray(done, done + take), inside)
        this.log.write(index, whole)
      }
      done += take
    }
    return SQLite.SQLITE_OK
  }
}

/**
 * A SQLite database of its own inside a Durable Object's storage, every
 * statement answered at once.
 *
 * SQLite runs here as WebAssembly, over a `PageLog` that keeps its pages in
 * the object's storage. What statements change stays in memory until
 * `flush`, which commits it to the storage whole.
 */
export class PagedDatabase {
  /** The bytes of BLOBs statements were given and answered, so far. */
  blobBytes = 0
  private closed = false
  private readonly statements = new Map<string, number>()
  private readonly free: number
  private readonly out: number
  private readonly prepareAt: Call<number>
  private readonly step: Call<number>
  private readonly reset: Call<number>
  private readonly finalize: Call<number>
  private readonly clearBindings: Call<number>
  private readonly closeDatabase: Call<number>
  private readonly bindBlob: Call<number>
  private readonly bindDouble: Call<number>
  private readonly bindInt64: Call<number>
  private readonly bindNull: Call<number>
  private readonly bindText: Call<number>
  private readonly columnCount: Call<number>
  private readonly columnName: Call<string>
  private readonly columnType: Call<number>
  private readonly columnInt64: Call<number>
  private readonly columnDouble: Call<number>
  private readonly columnText: Call<number>
  private readonly columnBlob: Call<number>
  private readonly columnBytes: Call<number>
  private readonly autocommit: Call<number>
  private readonly errmsg: Call<string>

  private constructor(
    private readonly module: SqliteModule,
    private readonly db: number,
    private readonly log: PageLog,
    private readonly vfs: PagedVFS,
  ) {
    const n = 'number'
    const call = <T>(name: string, returns: string, args: readonly string[]): Call<T> =>
      module.cwrap(name, returns, args) as Call<T>
    this.free = module._getSqliteFree()
    this.out = module._malloc(8)
    this.prepareAt = call('sqlite3_prepare_v2', n, [n, n, n, n, n])
    this.step = call('sqlite3_step', n, [n])
    this.reset = call('sqlite3_reset', n, [n])
    this.finalize = call('sqlite3_finalize', n, [n])
    this.clearBindings = call('sqlite3_clear_bindings', n, [n])
    this.closeDatabase = call('sqlite3_close', n, [n])
    this.bindBlob = call('sqlite3_bind_blob', n, [n, n, n, n, n])
    this.bindDouble = call('sqlite3_bind_double', n, [n, n, n])
    this.bindInt64 = call('sqlite3_bind_int64', n, [n, n, n, n])
    this.bindNull = call('sqlite3_bind_null', n, [n, n])
    this.bindText = call('sqlite3_bind_text', n, [n, n, n, n, n])
    this.columnCount = call('sqlite3_column_count', n, [n])
    this.columnName = call('sqlite3_column_name', 'string', [n, n])
    this.columnType = call('sqlite3_column_type', n, [n, n])
    this.columnInt64 = call('sqlite3_column_int64', n, [n, n])
    this.columnDouble = call('sqlite3_column_double', n, [n, n])
    this.columnText = call('sqlite3_column_text', n, [n, n])
    this.columnBlob = call('sqlite3_column_blob', n, [n, n])
    this.columnBytes = call('sqlite3_column_bytes', n, [n, n])
    this.autocommit = call('sqlite3_get_autocommit', n, [n])
    this.errmsg = call('sqlite3_errmsg', 'string', [n])
  }

  /**
   * Open the database `storage` holds, made when it holds none.
   *
   * @param storage a Durable Object's `ctx.storage`.
   * @param wasm the SQLite build, compiled.
   * @param options the memory the database may hold.
   */
  static async open(
    storage: DurableObjectStorageLike,
    wasm: WebAssembly.Module,
    options: PagedDatabaseOptions = {},
  ): Promise<PagedDatabase> {
    const module = (await createModule({
      locateFile: (name: string) => name,
      instantiateWasm(
        imports: WebAssembly.Imports,
        done: (instance: WebAssembly.Instance) => void,
      ): WebAssembly.Exports {
        const instance = new WebAssembly.Instance(wasm, imports)
        done(instance)
        return instance.exports
      },
    })) as SqliteModule
    const log = new PageLog(storage, options)
    const sqlite3 = SQLite.Factory(module)
    const vfs = new PagedVFS(log)
    sqlite3.vfs_register(vfs, false)
    const db = await sqlite3.open_v2(MAIN, undefined, VFS_NAME)
    const database = new PagedDatabase(module, db, log, vfs)
    // The page log is what makes a commit whole and lasting, so SQLite keeps
    // its journal in memory and waits on no sync.
    database.exec(`PRAGMA page_size = ${String(PAGE_BYTES)}`)
    database.exec('PRAGMA locking_mode = EXCLUSIVE')
    database.exec('PRAGMA journal_mode = MEMORY')
    database.exec('PRAGMA temp_store = MEMORY')
    database.exec('PRAGMA synchronous = OFF')
    const cacheKb = Math.ceil((options.pageCacheBytes ?? 2 << 20) / 1024)
    database.exec(`PRAGMA cache_size = ${String(-cacheKb)}`)
    return database
  }

  /** Whether no transaction is open. */
  get idle(): boolean {
    return this.autocommit(this.db) !== 0
  }

  /**
   * Run `sql` and answer its rows.
   *
   * @param sql one statement, or several run in turn, of which the last one's rows are answered.
   * @param params the values of the `?` parameters of the last statement.
   */
  exec(sql: string, params: readonly unknown[] = []): SqlRow[] {
    if (this.closed) throw new Error('the paged database is closed')
    const held = this.statements.get(sql)
    if (held !== undefined) {
      this.statements.delete(sql)
      this.statements.set(sql, held)
      return this.run(held, params, sql)
    }
    const m = this.module
    const [text, size] = this.text(sql)
    const end = text + size
    let rows: SqlRow[] = []
    try {
      // A statement is read once the one before it ran: it may use a table
      // that one made, and a PRAGMA takes effect as it is read.
      for (let at = text, first = true; at < end; first = false) {
        if (this.prepareAt(this.db, at, -1, this.out, this.out + 4) !== 0) throw this.fail(sql)
        const statement = m.getValue(this.out, '*')
        if (statement === 0) break
        at = m.getValue(this.out + 4, '*')
        const last = at >= end || ends(decoder.decode(m.HEAPU8.subarray(at, end)))
        if (first && last) {
          this.hold(sql, statement)
          return this.run(statement, params, sql)
        }
        try {
          rows = this.run(statement, last ? params : [], sql)
        } finally {
          this.finalize(statement)
        }
      }
    } finally {
      m._sqlite3_free(text)
    }
    return rows
  }

  /**
   * Commit what statements changed to the storage.
   *
   * @returns the rows the storage was billed for.
   * @throws when a transaction is open.
   */
  flush(): number {
    if (this.closed) return 0
    if (!this.idle) throw new Error('a paged database cannot flush inside a transaction')
    return this.log.flush()
  }

  /** Flush, then free the database: it runs no statement after. */
  close(): void {
    if (this.closed) return
    try {
      this.flush()
    } finally {
      for (const statement of this.statements.values()) this.finalize(statement)
      this.statements.clear()
      this.closeDatabase(this.db)
      this.closed = true
    }
  }

  private fail(sql: string): Error {
    const cause = this.vfs.failure
    this.vfs.failure = null
    const reason = cause === null ? this.errmsg(this.db) : cause.message
    return new Error(`${sql.slice(0, 80)}: ${reason}`, cause === null ? undefined : { cause })
  }

  // Keep a statement for the next time its text is run, the oldest kept given up.
  private hold(sql: string, statement: number): void {
    this.statements.set(sql, statement)
    if (this.statements.size <= STATEMENTS) return
    for (const [oldest, old] of this.statements) {
      this.statements.delete(oldest)
      this.finalize(old)
      break
    }
  }

  // `text` as UTF-8 in SQLite's memory with a NUL after it: where, and its bytes.
  private text(text: string): [number, number] {
    const bytes = encoder.encode(text)
    const at = this.module._sqlite3_malloc(bytes.byteLength + 1)
    this.module.HEAPU8.set(bytes, at)
    this.module.HEAPU8[at + bytes.byteLength] = 0
    return [at, bytes.byteLength]
  }

  private bind(statement: number, at: number, value: unknown): number {
    const m = this.module
    if (value === null || value === undefined) return this.bindNull(statement, at)
    if (typeof value === 'boolean') return this.bindInt64(statement, at, Number(value), 0)
    if (typeof value === 'number' && !Number.isInteger(value)) {
      return this.bindDouble(statement, at, value)
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      const wide = BigInt.asIntN(64, BigInt(value))
      return this.bindInt64(
        statement,
        at,
        Number(BigInt.asIntN(32, wide)),
        Number(BigInt.asIntN(32, wide >> 32n)),
      )
    }
    if (typeof value === 'string') {
      const [text, size] = this.text(value)
      return this.bindText(statement, at, text, size, this.free)
    }
    let blob: Uint8Array
    if (value instanceof Uint8Array) blob = value
    else if (value instanceof ArrayBuffer) blob = new Uint8Array(value)
    else if (ArrayBuffer.isView(value)) {
      blob = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    } else throw new Error(`a statement takes no ${typeof value} as a parameter`)
    this.blobBytes += blob.byteLength
    const memory = m._sqlite3_malloc(Math.max(blob.byteLength, 1))
    m.HEAPU8.set(blob, memory)
    return this.bindBlob(statement, at, memory, blob.byteLength, this.free)
  }

  private column(statement: number, at: number): SqlValue {
    const m = this.module
    switch (this.columnType(statement, at)) {
      case INTEGER: {
        const low = this.columnInt64(statement, at)
        const high = m.getTempRet0()
        if (high > 0x1fffff || high < -0x200000) {
          return (BigInt(high) << 32n) | BigInt.asUintN(32, BigInt(low))
        }
        return high * 0x100000000 + (low >>> 0)
      }
      case FLOAT:
        return this.columnDouble(statement, at)
      case TEXT: {
        const memory = this.columnText(statement, at)
        const size = this.columnBytes(statement, at)
        return decoder.decode(m.HEAPU8.subarray(memory, memory + size))
      }
      case BLOB: {
        const size = this.columnBytes(statement, at)
        const memory = this.columnBlob(statement, at)
        this.blobBytes += size
        return m.HEAPU8.slice(memory, memory + size)
      }
      default:
        return null
    }
  }

  private run(statement: number, params: readonly unknown[], sql: string): SqlRow[] {
    const rows: SqlRow[] = []
    try {
      params.forEach((value, i) => {
        if (this.bind(statement, i + 1, value) !== 0) throw this.fail(sql)
      })
      let names: string[] | null = null
      for (;;) {
        const code = this.step(statement)
        if (code === SQLite.SQLITE_DONE) break
        if (code !== SQLite.SQLITE_ROW) throw this.fail(sql)
        names ??= Array.from({ length: this.columnCount(statement) }, (_, i) =>
          this.columnName(statement, i),
        )
        const row: SqlRow = {}
        names.forEach((name, i) => {
          row[name] = this.column(statement, i)
        })
        rows.push(row)
      }
    } finally {
      this.reset(statement)
      this.clearBindings(statement)
    }
    return rows
  }
}
