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

import { BaseVFS } from '../base.ts'
import { BoxAccessor } from '../../accessor/box.ts'
import { BoxTokenManager } from '../../core/box/client.ts'
import { VFSName } from '../../types.ts'
import { redactBoxConfig, type BoxConfig, type BoxConfigRedacted } from './config.ts'
import { buildDeltaHook } from '../../core/box/events.ts'
import { type DeltaHook } from '../../events/index.ts'
import type { CapacityResult, PathSpec, FileStat } from '../../types.ts'
import { capacity as boxCapacity } from '../../core/box/capacity.ts'
import type { Handed } from '../types.ts'
import { readdir as boxReaddir } from '../../core/box/readdir.ts'
import { read as boxRead, readStream as boxStream } from '../../core/box/read.ts'
import { checksum as boxChecksum } from '../../core/box/checksum.ts'
import { stat as boxStat } from '../../core/box/stat.ts'
import { exists as boxExists } from '../../core/box/exists.ts'
import type { ByteSource } from '../../io/types.ts'
import { write as boxWrite } from '../../core/box/write.ts'
import { create as boxCreate } from '../../core/box/create.ts'
import { mkdir as boxMkdir } from '../../core/box/mkdir.ts'
import { unlink as boxUnlink } from '../../core/box/unlink.ts'
import { rmdir as boxRmdir, rmR as boxRmR } from '../../core/box/rmdir.ts'
import { rename as boxRename } from '../../core/box/rename.ts'
import { copy as boxCopy } from '../../core/box/copy.ts'
import { truncate as boxTruncate } from '../../core/box/truncate.ts'
import { filesContaining as boxFilesContaining } from '../../core/box/search.ts'
import { WALK_LIMIT } from '../constants.ts'

export const VFS_MD = `{prefix}
  Mirrors Box folder hierarchy. Every item is served as its raw bytes:
    <name>.boxnote      Box Note    (raw ProseMirror-style JSON; pipe to jq)
    <name>.boxcanvas    Box Canvas  (raw canvas JSON; pipe to jq)
    <name>.gdoc/.gsheet/.gslides  Box's Google-Workspace files, stored as
                        Office Open XML (docx/xlsx/pptx) - opaque binary
    <other-files>       PDFs, images, binaries, etc. - raw bytes

  IMPORTANT: This is a remote mount. Prefer targeted reads over full scans.
  Box uses numeric folder IDs internally (root = 0); mirage caches the
  path -> id mapping, so nested dirs cost one API call per level on first
  access. Use ls on the parent dir before constructing a path.`

export interface BoxVFSState {
  type: string
  config: BoxConfigRedacted
}

export class BoxVFS extends BaseVFS {
  override readonly name: string = VFSName.BOX
  override readonly cachesReads: boolean = true
  // Box item listings carry an exact byte `size` for every file (0
  // included); sizeless weblinks are filtered out of listings.
  override readonly sizesAlwaysKnown: boolean = true
  // stat and every whole read stamp the file's sha1, which a listing row
  // and GET /files/{id} carry. A download names no version, so a read
  // checks its bytes against the row it resolved through.
  override readonly readRevalidatable: boolean = true
  override readonly indexTtl: number = 86_400
  override readonly handed = {
    readdir: ['entry'],
    read: ['entry'],
    stat: ['entry', 'index'],
    checksum: ['entry'],
    exists: ['entry'],
    write: ['entry', 'parent'],
    create: ['entry', 'parent'],
    mkdir: ['parent'],
    unlink: ['entry'],
    rmdir: ['entry'],
    rmR: ['entry'],
    rename: ['entry', 'dstParent', 'dstEntry'],
    copy: ['entry', 'dstParent', 'dstEntry'],
    dirCopy: ['entry', 'dstParent', 'dstEntry'],
    truncate: ['entry', 'parent'],
    filesContaining: ['entry'],
  } as const
  override vfsMd: string = VFS_MD
  override readonly wholeWordSearch: boolean = true
  readonly config: BoxConfig
  override readonly accessor: BoxAccessor

  override readonly walkLimit: number

  constructor(config: BoxConfig) {
    super()
    this.config = config
    this.walkLimit = config.walkLimit ?? WALK_LIMIT
    // The whole config goes to the token manager, never a hand-picked
    // subset: a field added to BoxConfig would silently stop reaching it
    // (that is how gdrive lost apiBase and kept refreshing at the real
    // Google endpoint against a fake server).
    const tm = new BoxTokenManager(config)
    this.accessor = new BoxAccessor({
      tokenManager: tm,
      ...(config.rootFolderId !== undefined ? { rootFolderId: config.rootFolderId } : {}),
    })
  }

  override readonly readsRanges: boolean = true

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[]> {
    return boxReaddir(this.accessor, path, handed?.entry)
  }

  override read(
    path: PathSpec,
    handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> | AsyncIterable<Uint8Array> {
    if (offset === 0 && size === null) return boxStream(this.accessor, path, handed?.entry)
    return boxRead(
      this.accessor,
      path,
      size === null ? { offset } : { offset, size },
      handed?.entry,
    )
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return boxStat(this.accessor, path, handed?.entry, handed?.index)
  }

  override checksum(path: PathSpec, algorithm: string, handed?: Handed): Promise<string | null> {
    return boxChecksum(this.accessor, path, algorithm, handed?.entry)
  }

  override exists(path: PathSpec, handed?: Handed): Promise<boolean> {
    return boxExists(this.accessor, path, handed?.entry)
  }

  override write(
    path: PathSpec,
    data: ByteSource,
    signal?: AbortSignal,
    handed: Handed = {},
  ): Promise<FileStat | null> {
    return boxWrite(this.accessor, path, data, handed, signal)
  }

  override create(path: PathSpec, handed: Handed = {}): Promise<FileStat | null> {
    return boxCreate(this.accessor, path, handed)
  }

  override mkdir(path: PathSpec, parents = false, handed: Handed = {}): Promise<FileStat | null> {
    return boxMkdir(this.accessor, path, parents, handed)
  }

  override unlink(path: PathSpec, handed?: Handed): Promise<void> {
    return boxUnlink(this.accessor, path, handed)
  }

  override rmdir(path: PathSpec, handed?: Handed): Promise<void> {
    return boxRmdir(this.accessor, path, handed)
  }

  override rmR(path: PathSpec, handed: Handed = {}): Promise<void> {
    return boxRmR(this.accessor, path, handed)
  }

  override rename(src: PathSpec, dst: PathSpec, handed: Handed = {}): Promise<FileStat | null> {
    return boxRename(this.accessor, src, dst, handed)
  }

  override copy(
    src: PathSpec,
    dst: PathSpec,
    _signal?: AbortSignal,
    handed: Handed = {},
  ): Promise<FileStat | null> {
    return boxCopy(this.accessor, src, dst, handed)
  }

  override dirCopy(src: PathSpec, dst: PathSpec, handed: Handed = {}): Promise<FileStat | null> {
    return boxCopy(this.accessor, src, dst, handed)
  }

  override truncate(
    path: PathSpec,
    length: number,
    noCreate = false,
    handed: Handed = {},
  ): Promise<void> {
    return boxTruncate(this.accessor, path, length, noCreate, handed)
  }

  /**
   * Whether this VFS answers `name`; with no walk limit it reads every
   * file rather than ask the service's search.
   */
  override supports(name: string): boolean {
    if (name === 'files_containing' && this.fullScanLimit < 0) return false
    return super.supports(name)
  }

  override filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
    handed?: Handed,
  ): Promise<PathSpec[] | null> {
    if (!opts.wholeWord || this.walkLimit < 0) return Promise.resolve(null)
    return boxFilesContaining(this.accessor, text, path, handed?.entry)
  }

  override capacity(): Promise<CapacityResult> {
    return boxCapacity(this.accessor)
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<BoxVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactBoxConfig(this.config),
    })
  }
}
