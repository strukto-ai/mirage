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

import { enoent } from '../../errors/fs.ts'
import { Descriptor, type RuntimeFiles } from '../files.ts'
import type { OpenMode } from '../handles/mode.ts'
import type { VFSEntry, VFSStat } from '../types.ts'
import { entryName } from '../../utils/remnants.ts'
import { filetypeOf } from './stat.ts'

/**
 * The filesystem a wasm guest sees: the workspace mounts, through the
 * runtimes' file API. Mirrors Python's `WasmView` for a guest that
 * carries no files of its own (qjs), which is the only one this host
 * runs: no interpreter build is routed beside the mounts.
 *
 * Its job is shape. `RuntimeFiles` answers in virtual paths and one
 * `VFSStat` per path; preview1 asks in `[name, filetype]` pairs and
 * errno, and its filestat record has no mode field at all, so the type
 * bits are read out of the mode and the rest is dropped.
 *
 * @param files - the shared mount op vocabulary, its calls stopped with
 *   the run (`RuntimeFiles.withSignal`); null when no workspace is
 *   attached, so the guest sees nothing.
 */
export class WasmView {
  constructor(private readonly files: RuntimeFiles | null = null) {}

  private requireFiles(): RuntimeFiles {
    if (this.files === null) throw enoent('/')
    return this.files
  }

  /**
   * The file adapter for a content call on `path`, inside the view only.
   * Structure is open (a stat, a listing or a readlink answers for any
   * path the workspace has), but content goes only through the runtime's
   * view (`RuntimeFiles.serves`), the rule every guest file adapter keeps.
   */
  private filesFor(path: string): RuntimeFiles {
    const files = this.files
    if (files?.serves(path) !== true) throw enoent(path)
    return files
  }

  /** Stat a guest path. */
  stat(path: string): Promise<VFSStat> {
    return this.coreStat(path)
  }

  /**
   * Stat a guest path without following a trailing symlink: a link's own
   * row is the node table's, which the dispatcher serves under `nofollow`.
   */
  lstat(path: string): Promise<VFSStat> {
    return this.coreStat(path, true)
  }

  /**
   * The adapter's own stat, or ENOENT when no workspace is attached. A
   * path outside the view still answers as structure: a directory row
   * when the workspace lists it (`RuntimeFiles.viewStat`).
   */
  private async coreStat(path: string, nofollow = false): Promise<VFSStat> {
    const files = this.requireFiles()
    if (files.serves(path)) return files.stat(path, nofollow)
    const row = await files.viewStat(path)
    if (row === null) throw enoent(path)
    return row
  }

  /** The path's row, or null when the workspace does not have it. */
  async statOrNull(path: string, nofollow = false): Promise<VFSStat | null> {
    try {
      return await (nofollow ? this.lstat(path) : this.stat(path))
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') return null
      throw err
    }
  }

  /**
   * The mount's unclassified rows for `path`, or null. Asked of a path
   * with no row; a path outside the view never lists here, its stat
   * having already answered the directory row `viewStat` finds.
   */
  async listingOrNull(path: string): Promise<VFSEntry[] | null> {
    const files = this.requireFiles()
    return files.serves(path) ? files.listingOrNull(path) : null
  }

  /** A file's bytes, or a range of them. */
  read(path: string, offset = 0, size?: number, raw = false): Promise<Uint8Array> {
    return this.filesFor(path).read(path, { offset, ...(size !== undefined ? { size } : {}), raw })
  }

  /** Open a workspace file on the run's core, the open's effect landing there. */
  async open(path: string, mode: OpenMode): Promise<Descriptor> {
    const files = this.filesFor(path)
    return new Descriptor(
      files,
      await files.open(path, mode),
      mode,
      path,
      false,
      files.walked(path),
    )
  }

  unlink(path: string): Promise<void> {
    return this.filesFor(path).unlink(path)
  }

  mkdir(path: string): Promise<void> {
    return this.filesFor(path).mkdir(path)
  }

  rmdir(path: string): Promise<void> {
    return this.filesFor(path).rmdir(path)
  }

  /** Rename within the workspace. */
  rename(src: string, dst: string): Promise<void> {
    this.filesFor(dst)
    return this.filesFor(src).rename(src, dst)
  }

  /** Create a symlink at `path` pointing at `target`, stored as typed. */
  symlink(path: string, target: string): Promise<void> {
    return this.filesFor(path).symlink(path, target)
  }

  /** Where the namespace's links lead `path` (`RuntimeFiles.walked`). */
  walked(path: string, follow = true): string {
    return this.files === null ? path : this.files.walked(path, follow)
  }

  /** The target of the symlink at `path`; EINVAL when it is no link. */
  readlink(path: string): Promise<string> {
    if (this.files === null) throw enoent(path)
    return this.files.readlink(path)
  }

  /**
   * Write timestamps, in the namespace overlay where needed. Times are
   * the only attributes preview1 can express.
   */
  setattr(
    path: string,
    atime: string | null,
    mtime: string | null,
    nofollow: boolean,
  ): Promise<void> {
    return this.filesFor(path).setattr(path, {
      ...(atime !== null ? { atime } : {}),
      ...(mtime !== null ? { mtime } : {}),
      nofollow,
    })
  }

  /**
   * List a guest directory as `[name, preview1 filetype]` pairs. Core
   * entries arrive kind-resolved, and a link is reported as one, so a
   * guest that reads `d_type` answers `is_symlink` without a call.
   */
  async readdir(path: string): Promise<[string, number][]> {
    const entries = new Map<string, number>()
    for (const entry of await this.requireFiles().readdir(path)) {
      const base = entryName(entry.path)
      if (base !== '') entries.set(base, filetypeOf(entry))
    }
    return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  }
}
