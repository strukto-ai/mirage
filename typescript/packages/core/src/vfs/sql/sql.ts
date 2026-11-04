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

import { SqlAccessor } from '../../accessor/sql.ts'
import { count as sqlCount, sizeOf as sqlSizeOf } from '../../core/sql/capacity.ts'
import { copy as sqlCopy } from '../../core/sql/copy.ts'
import { create as sqlCreate } from '../../core/sql/create.ts'
import { exists as sqlExists } from '../../core/sql/exists.ts'
import { mkdir as sqlMkdir } from '../../core/sql/mkdir.ts'
import { read as sqlRead } from '../../core/sql/read.ts'
import { readdir as sqlReaddir, tree as sqlTree } from '../../core/sql/readdir.ts'
import { rename as sqlRename } from '../../core/sql/rename.ts'
import { rmR as sqlRmR } from '../../core/sql/rm.ts'
import { rmdir as sqlRmdir } from '../../core/sql/rmdir.ts'
import { restore, snapshot, type SqlSnapshot } from '../../core/sql/snapshot.ts'
import { stat as sqlStat } from '../../core/sql/stat.ts'
import { readStream as sqlStream } from '../../core/sql/stream.ts'
import { truncate as sqlTruncate } from '../../core/sql/truncate.ts'
import { unlink as sqlUnlink } from '../../core/sql/unlink.ts'
import { write as sqlWrite } from '../../core/sql/write.ts'
import type { ByteSource } from '../../io/types.ts'
import {
  CapacityState,
  VFSName,
  type CapacityResult,
  type FileStat,
  type PathSpec,
} from '../../types.ts'
import { BaseVFS } from '../base.ts'
import { charge, storageUsage, type Charge, type StorageUsage } from '../capacity.ts'
import type { Handed, VFSStateBase } from '../types.ts'
import type { SqlDriver } from './types.ts'

export interface SqlVFSOptions {
  /** The most bytes the mount's files may hold: a size like `100MB` or a count of bytes. */
  capacity?: number | string | null
  /** Whether closing the mount closes `driver`; a passed driver is borrowed by default. */
  ownsDriver?: boolean
}

/**
 * A filesystem kept in SQL tables, over whatever driver it is given: a SQLite
 * file, a Postgres server, a Durable Object's own storage, a D1 database.
 *
 * The tables hold the files alone, laid out as AgentFS's: an inode per file
 * and directory, an entry naming each under its parent, and a file's bytes in
 * rows of the database's chunk size. A path's mode, owner and symlinks are
 * the namespace's, and a session's env and cwd the workspace store's, as on
 * any mount that keeps no attributes; the mount answers no `setattr`. Each op
 * resolves its path in one query and lands its change in one transaction.
 * One database holds one filesystem. Mirrors Python's `SqlVFS`.
 */
export class SqlVFS extends BaseVFS<SqlAccessor> {
  override readonly name: string = VFSName.SQL
  override readonly cachesReads: boolean = false
  // byte store: stat() sizes every file from metadata
  override readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 0
  override readonly readsRanges: boolean = true
  override readonly local: boolean = true
  override readonly accessor: SqlAccessor
  override readonly usage: StorageUsage | null
  private readonly ownsDriver: boolean

  /**
   * `capacity` is the most bytes the mount's files may hold, a size like
   * `100MB` or a count of bytes; null for no limit. Counted at the first
   * write or `df`; a writer in another process is counted at the next `df`.
   *
   * @throws VFSConfigError when `capacity` is not a size.
   */
  constructor(driver: SqlDriver, options: SqlVFSOptions = {}) {
    super()
    this.accessor = new SqlAccessor(driver)
    this.usage = storageUsage(this.name, options.capacity ?? null)
    this.ownsDriver = options.ownsDriver ?? false
  }

  private charge<T>(path: PathSpec, write: (held: Charge) => Promise<T>): Promise<T> {
    return charge(
      this.usage,
      path,
      (p) => sqlSizeOf(this.accessor, p),
      () => sqlCount(this.accessor),
      write,
    )
  }

  override storageLocation(): string {
    return `${this.name}:${this.accessor.driver.location}`
  }

  override async close(): Promise<void> {
    if (this.ownsDriver) await this.accessor.driver.close()
    await super.close()
  }

  override readTree(path: PathSpec): Promise<Map<string, FileStat> | null> {
    return sqlTree(this.accessor, path)
  }

  override readdir(path: PathSpec): Promise<FileStat[]> {
    return sqlReaddir(this.accessor, path)
  }

  override read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> | AsyncIterable<Uint8Array> {
    if (offset === 0 && size === null) return sqlStream(this.accessor, path)
    return sqlRead(this.accessor, path, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return sqlStat(this.accessor, path)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return sqlExists(this.accessor, path)
  }

  override write(
    path: PathSpec,
    data: ByteSource,
    _signal?: AbortSignal,
    _handed?: Handed,
    atomic = false,
  ): Promise<void> {
    return this.charge(path, (held) =>
      sqlWrite(this.accessor, path, held.stream(data), false, atomic),
    )
  }

  override append(path: PathSpec, data: ByteSource): Promise<void> {
    return this.charge(path, (held) => sqlWrite(this.accessor, path, held.stream(data, true), true))
  }

  override create(path: PathSpec): Promise<void> {
    return this.charge(path, () => sqlCreate(this.accessor, path))
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return sqlMkdir(this.accessor, path, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return this.charge(path, () => sqlUnlink(this.accessor, path))
  }

  override rmdir(path: PathSpec): Promise<void> {
    return sqlRmdir(this.accessor, path)
  }

  override rmR(path: PathSpec): Promise<void> {
    return this.charge(path, () => sqlRmR(this.accessor, path))
  }

  override rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return this.charge(src, () => this.charge(dst, () => sqlRename(this.accessor, src, dst)))
  }

  override copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return this.charge(dst, async (held) => {
      if (this.usage === null) return sqlCopy(this.accessor, src, dst)
      held.growTo(await sqlSizeOf(this.accessor, src))
      await sqlCopy(this.accessor, src, dst)
      const copied = await sqlSizeOf(this.accessor, dst)
      try {
        held.growTo(copied)
      } catch (err) {
        await sqlTruncate(this.accessor, dst, held.reserved, true)
        throw err
      }
    })
  }

  override truncate(path: PathSpec, length: number, noCreate = false): Promise<void> {
    return this.charge(path, async (held) => {
      if (!noCreate || (await this.exists(path))) held.growTo(length)
      await sqlTruncate(this.accessor, path, length, noCreate)
    })
  }

  /** The mount's own quota when capped, counted afresh so a writer in
   * another process shows; else a database that grows (ELASTIC). Mirrors
   * Python's. */
  override async capacity(): Promise<CapacityResult> {
    if (this.usage === null) return { state: CapacityState.ELASTIC }
    this.usage.stale()
    await this.usage.counted(() => sqlCount(this.accessor))
    return this.usage.report()
  }

  override async getState(): Promise<
    SqlSnapshot & { type: string; config: { capacity?: number } }
  > {
    return {
      type: this.name,
      config: this.usage !== null ? { capacity: this.usage.limit } : {},
      ...(await snapshot(this.accessor)),
    }
  }

  override async loadState(state: VFSStateBase & Partial<SqlSnapshot>): Promise<void> {
    await restore(this.accessor, {
      files: state.files ?? {},
      dirs: state.dirs ?? ['/'],
      modified: state.modified ?? {},
    })
    this.usage?.stale()
  }
}
