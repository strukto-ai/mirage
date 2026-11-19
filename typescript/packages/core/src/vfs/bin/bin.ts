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

import { BinAccessor } from '../../accessor/bin.ts'
import { read as binRead } from '../../core/bin/read.ts'
import { readdir as binReaddir } from '../../core/bin/readdir.ts'
import { refuse } from '../../core/bin/refuse.ts'
import { stat as binStat } from '../../core/bin/stat.ts'
import { isEnoent, isFsError } from '../../errors/fs.ts'
import type { ByteSource } from '../../io/types.ts'
import type { FileStat, PathSpec, SetAttrFields } from '../../types.ts'
import { DirListing, VFSName } from '../../types.ts'
import { nowIso } from '../../utils/dates.ts'
import { stripSlash } from '../../utils/slash.ts'
import { BaseVFS } from '../base.ts'
import { type VFSStateBase } from '../types.ts'

/**
 * Read-only view VFS backing the /usr/bin mount. Lists one executable
 * file per program Mirage runs, rendered from the workspace's command
 * lookup on every call; holds no storage of its own. A name it leaves to
 * what lies under it (one a machine runs, or none of Mirage's) is the file
 * the mount beneath shows at that path: with a machine's disk at `/`,
 * `/usr/bin/python3` is the machine's own file and `/usr/bin/grep`
 * Mirage's. Where nothing lies beneath, a program a machine runs keeps its
 * file here.
 */
export class BinViewVFS extends BaseVFS {
  override readonly name = VFSName.BIN
  override readonly cachesReads = false
  // A stub's size is its rendering: cheap, no network, never null.
  override readonly sizesAlwaysKnown = true
  override readonly accessor: BinAccessor
  private readonly leavesName: ((name: string) => boolean) | null
  private readonly beneath: ((virtual: string) => readonly [BaseVFS, PathSpec] | null) | null

  /**
   * @param programs every program name the session can run, sorted.
   * @param note the line one program's file says about it, null when the
   *   name runs as no program.
   * @param leaves whether the view leaves a name to the mount beneath; null
   *   leaves none.
   * @param beneath the mount beneath the view and the path in it, for a
   *   virtual path under the view; null when nothing lies there.
   */
  constructor(
    programs: () => string[],
    note: (name: string) => string | null,
    leaves: ((name: string) => boolean) | null = null,
    beneath: ((virtual: string) => readonly [BaseVFS, PathSpec] | null) | null = null,
  ) {
    super()
    this.accessor = new BinAccessor(programs, note, nowIso())
    this.leavesName = leaves
    this.beneath = beneath
  }

  /**
   * Whether the view leaves `name` to the mount beneath it: a program a
   * machine runs, or a name none of Mirage's layers runs.
   *
   * @param name a name under the view.
   */
  leaves(name: string): boolean {
    return this.leavesName !== null && !name.includes('/') && this.leavesName(name)
  }

  private below(path: PathSpec): readonly [BaseVFS, PathSpec] | null {
    const key = stripSlash(path.mountPath)
    if (this.beneath === null || (key !== '' && !this.leaves(key))) return null
    return this.beneath(path.virtual)
  }

  override async readdir(path: PathSpec): Promise<FileStat[]> {
    const mine = await binReaddir(this.accessor, path)
    const below = this.below(path)
    if (below === null) return mine
    const [vfs, spec] = below
    let listed: readonly FileStat[] | DirListing
    try {
      listed = await vfs.readdir(spec)
    } catch (err) {
      if (!isFsError(err)) throw err
      console.debug(`nothing beneath ${path.virtual}: ${String(err)}`)
      return mine
    }
    const theirs = listed instanceof DirListing ? listed.entries : listed
    const held = new Set(theirs.filter((row) => this.leaves(row.name)).map((row) => row.name))
    const kept = mine.filter((row) => !held.has(row.name))
    const named = new Set(kept.map((row) => row.name))
    const rows = [...kept, ...theirs.filter((row) => !named.has(row.name) && this.leaves(row.name))]
    return rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  override async read(path: PathSpec): Promise<ByteSource> {
    const below = this.below(path)
    if (below !== null && stripSlash(path.mountPath) !== '') {
      const [vfs, spec] = below
      let there = true
      try {
        await vfs.stat(spec)
      } catch (err) {
        if (!isEnoent(err)) throw err
        console.debug(`${path.virtual}: none beneath`)
        there = false
      }
      if (there) return vfs.read(spec)
    }
    return binRead(this.accessor, path)
  }

  override async stat(path: PathSpec): Promise<FileStat> {
    const below = this.below(path)
    if (below !== null && stripSlash(path.mountPath) !== '') {
      const [vfs, spec] = below
      try {
        return await vfs.stat(spec)
      } catch (err) {
        if (!isEnoent(err)) throw err
        console.debug(`${path.virtual}: none beneath`)
      }
    }
    return binStat(this.accessor, path)
  }

  // Every write is its own refusal instead of a missing function, which
  // would answer "Operation not supported" where a read-only directory says
  // EROFS.
  override write(path: PathSpec): Promise<void> {
    return refuse(this.accessor, path)
  }

  override append(path: PathSpec): Promise<void> {
    return refuse(this.accessor, path)
  }

  override pwrite(path: PathSpec): Promise<void> {
    return refuse(this.accessor, path)
  }

  override create(path: PathSpec): Promise<void> {
    return refuse(this.accessor, path)
  }

  override mkdir(path: PathSpec): Promise<void> {
    return refuse(this.accessor, path)
  }

  override unlink(path: PathSpec): Promise<void> {
    return refuse(this.accessor, path)
  }

  override rmdir(path: PathSpec): Promise<void> {
    return refuse(this.accessor, path)
  }

  override rename(src: PathSpec): Promise<void> {
    return refuse(this.accessor, src)
  }

  override truncate(path: PathSpec): Promise<void> {
    return refuse(this.accessor, path)
  }

  override setattr(
    path: PathSpec,
    _fields: SetAttrFields,
  ): Promise<Record<string, number | string>> {
    return refuse(this.accessor, path)
  }

  /** The view owns nothing, so its type alone rebuilds it. */
  override getState(): VFSStateBase {
    return { type: this.name }
  }
}
