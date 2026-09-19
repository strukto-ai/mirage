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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { RAM_COMMANDS } from '../../commands/builtin/ram/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { appendBytes as appendCore } from '../../core/ram/append.ts'
import { copy as copyCore } from '../../core/ram/copy.ts'
import { create as createCore } from '../../core/ram/create.ts'
import { size as duSizeCore, entries as duEntriesCore } from '../../core/ram/du/index.ts'
import { exists as existsCore } from '../../core/ram/exists.ts'
import { find as findCore, type FindOptions as RAMFindOptions } from '../../core/ram/find.ts'
import { makeResolveGlob } from '../../commands/builtin/generic_bind/index.ts'
import { SCOPE_ERROR } from '../../core/ram/constants.ts'
import { mkdir as mkdirCore } from '../../core/ram/mkdir.ts'
import { read as readCore } from '../../core/ram/read.ts'
import { readdir as readdirCore } from '../../core/ram/readdir.ts'
import { rename as renameCore } from '../../core/ram/rename.ts'
import { rmR as rmRCore } from '../../core/ram/rm.ts'
import { rmdir as rmdirCore } from '../../core/ram/rmdir.ts'
import { stat as statCore } from '../../core/ram/stat.ts'
import { stream as streamCore } from '../../core/ram/stream.ts'
import { truncate as truncateCore } from '../../core/ram/truncate.ts'
import { unlink as unlinkCore } from '../../core/ram/unlink.ts'
import { writeBytes as writeCore } from '../../core/ram/write.ts'
import { RAMAccessor } from '../../accessor/ram.ts'
import { RAM_OPS } from '../../ops/ram/index.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { PathSpec, VFSName, type FileStat } from '../../types.ts'
import { BaseVFS, type FindOptions } from '../base.ts'
import { RAM_PROMPT } from './prompt.ts'
import { RAMStore, type RAMAttrs } from './store.ts'

const globCore = makeResolveGlob(readdirCore, SCOPE_ERROR)

export interface RAMVFSState {
  type: string
  files?: Record<string, Uint8Array>
  dirs?: string[]
  modified?: Record<string, string>
  attrs?: Record<string, RAMAttrs>
}

export class RAMVFS extends BaseVFS {
  readonly kind = VFSName.RAM
  override readonly cachesReads: boolean = false
  // byte store: stat() sizes every file from metadata
  override readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 0
  readonly store = new RAMStore()
  override readonly accessor = new RAMAccessor(this.store)
  override readonly prompt = RAM_PROMPT
  override readonly opsMap: Record<string, unknown> = {
    read_bytes: readCore,
    write: writeCore,
    readdir: readdirCore,
    stat: statCore,
    unlink: unlinkCore,
    rmdir: rmdirCore,
    copy: copyCore,
    rename: renameCore,
    mkdir: mkdirCore,
    read_stream: streamCore,
    rm_recursive: rmRCore,
    du_size: duSizeCore,
    du_entries: duEntriesCore,
    create: createCore,
    truncate: truncateCore,
    exists: existsCore,
    find_flat: findCore,
    append: appendCore,
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  override ops(): readonly RegisteredOp[] {
    return RAM_OPS
  }

  override commands(): readonly RegisteredCommand[] {
    return RAM_COMMANDS
  }

  override streamPath(path: PathSpec): AsyncIterable<Uint8Array> {
    return streamCore(this.accessor, path)
  }

  override readFile(path: PathSpec): Promise<Uint8Array> {
    return readCore(this.accessor, path)
  }

  override writeFile(path: PathSpec, data: Uint8Array): Promise<void> {
    return writeCore(this.accessor, path, data)
  }

  override appendFile(path: PathSpec, data: Uint8Array): Promise<void> {
    return appendCore(this.accessor, path, data)
  }

  override readdir(path: PathSpec): Promise<string[]> {
    return readdirCore(this.accessor, path, this.index)
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return statCore(this.accessor, path)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return existsCore(this.accessor, path)
  }

  override mkdir(path: PathSpec, options?: { recursive?: boolean }): Promise<void> {
    return mkdirCore(this.accessor, path, options?.recursive === true)
  }

  override rmdir(path: PathSpec): Promise<void> {
    return rmdirCore(this.accessor, path)
  }

  override unlink(path: PathSpec): Promise<void> {
    return unlinkCore(this.accessor, path)
  }

  override rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return renameCore(this.accessor, src, dst)
  }

  override truncate(path: PathSpec, length: number): Promise<void> {
    return truncateCore(this.accessor, path, length)
  }

  override copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return copyCore(this.accessor, src, dst)
  }

  override rmR(path: PathSpec): Promise<void> {
    return rmRCore(this.accessor, path)
  }

  override du(path: PathSpec): Promise<number> {
    return duSizeCore(this.accessor, path)
  }

  override find(path: PathSpec, options: FindOptions = {}): Promise<string[]> {
    return findCore(this.accessor, path, options as RAMFindOptions)
  }

  override glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective = prefix
      ? paths.map((p) =>
          mountPrefixOf(p.virtual, p.vfsPath)
            ? p
            : new PathSpec({
                virtual: p.virtual,
                directory: p.directory,
                ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                resolved: p.resolved,
                vfsPath: mountKey(p.virtual, prefix),
              }),
        )
      : paths
    return globCore(this.accessor, effective, this.index)
  }

  override getState(): RAMVFSState {
    const files: Record<string, Uint8Array> = {}
    for (const [k, v] of this.store.files) files[k] = v
    const modified: Record<string, string> = {}
    for (const [k, v] of this.store.modified) modified[k] = v
    const attrs: Record<string, RAMAttrs> = {}
    for (const [k, v] of this.store.attrs) attrs[k] = { ...v }
    return {
      type: this.kind,
      files,
      dirs: [...this.store.dirs],
      modified,
      attrs,
    }
  }

  override loadState(state: RAMVFSState): void {
    this.store.files.clear()
    for (const [k, v] of Object.entries(state.files ?? {})) this.store.files.set(k, v)
    this.store.dirs.clear()
    const dirs = state.dirs ?? []
    for (const d of dirs.length > 0 ? dirs : ['/']) this.store.dirs.add(d)
    this.store.modified.clear()
    for (const [k, v] of Object.entries(state.modified ?? {})) this.store.modified.set(k, v)
    this.store.attrs.clear()
    for (const [k, v] of Object.entries(state.attrs ?? {})) this.store.attrs.set(k, { ...v })
  }
}
