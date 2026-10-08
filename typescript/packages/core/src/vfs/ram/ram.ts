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

import { RAMAccessor } from '../../accessor/ram.ts'
import { VFSName } from '../../types.ts'
import { BaseVFS } from '../base.ts'
import { PROMPT } from './prompt.ts'
import { RAMStore, type RAMAttrs } from './store.ts'
import type { PathSpec, FileStat, SetAttrFields } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FindOptions } from '../base.ts'
import type { DuEntries } from '../types.ts'
import { readdir as ramReaddir } from '../../core/ram/readdir.ts'
import { read as devAwareRead, readRange as devAwareReadRange } from '../../core/dev/read.ts'
import { stat as devAwareStat } from '../../core/dev/stat.ts'
import { readStream as devAwareStream } from '../../core/dev/stream.ts'
import { exists as ramExists } from '../../core/ram/exists.ts'
import { find as ramFind } from '../../core/ram/find.ts'
import { size as ramDu, entries as ramDuAll } from '../../core/ram/du/index.ts'
import { write as ramWrite } from '../../core/ram/write.ts'
import { appendBytes as ramAppend } from '../../core/ram/append.ts'
import { pwrite as ramPwrite } from '../../core/ram/pwrite.ts'
import { create as ramCreate } from '../../core/ram/create.ts'
import { mkdir as ramMkdir } from '../../core/ram/mkdir.ts'
import { unlink as ramUnlink } from '../../core/ram/unlink.ts'
import { rmdir as ramRmdir } from '../../core/ram/rmdir.ts'
import { rmR as ramRmR } from '../../core/ram/rm.ts'
import { rename as ramRename } from '../../core/ram/rename.ts'
import { copy as ramCopy } from '../../core/ram/copy.ts'
import { truncate as ramTruncate } from '../../core/ram/truncate.ts'
import { setAttrs as ramSetAttrs } from '../../core/ram/set_attrs.ts'
import { SCOPE_ERROR } from '../../core/ram/constants.ts'
export interface RAMVFSState {
  type: string
  files?: Record<string, Uint8Array>
  dirs?: string[]
  modified?: Record<string, string>
  attrs?: Record<string, RAMAttrs>
}

export class RAMVFS extends BaseVFS {
  override readonly name = VFSName.RAM
  override readonly cachesReads: boolean = false
  // byte store: stat() sizes every file from metadata
  override readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 0
  readonly store = new RAMStore()
  override readonly accessor = new RAMAccessor(this.store)
  override readonly prompt = PROMPT
  override readonly readsRanges: boolean = true

  override readonly local: boolean = true

  override readonly maxGlobMatches: number = SCOPE_ERROR

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return ramReaddir(this.accessor, path, index)
  }

  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) return devAwareRead(this.accessor, path, index)
    return devAwareReadRange(this.accessor, path, index, offset, size)
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return devAwareStat(this.accessor, path, index)
  }

  override readStream(path: PathSpec, index?: IndexCacheStore): AsyncIterable<Uint8Array> {
    return devAwareStream(this.accessor, path, index)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return ramExists(this.accessor, path)
  }

  override find(path: PathSpec, options: FindOptions, _index?: IndexCacheStore): Promise<string[]> {
    return ramFind(this.accessor, path, options)
  }

  override duSize(path: PathSpec, _index?: IndexCacheStore): Promise<number> {
    return ramDu(this.accessor, path)
  }

  override duEntries(path: PathSpec, _index?: IndexCacheStore): Promise<DuEntries> {
    return ramDuAll(this.accessor, path)
  }

  override write(path: PathSpec, data: Uint8Array): Promise<void> {
    return ramWrite(this.accessor, path, data)
  }

  override append(path: PathSpec, data: Uint8Array): Promise<void> {
    return ramAppend(this.accessor, path, data)
  }

  override pwrite(path: PathSpec, data: Uint8Array, offset: number): Promise<void> {
    return ramPwrite(this.accessor, path, data, offset)
  }

  override create(path: PathSpec): Promise<void> {
    return ramCreate(this.accessor, path)
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return ramMkdir(this.accessor, path, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return ramUnlink(this.accessor, path)
  }

  override rmdir(path: PathSpec, _index?: IndexCacheStore): Promise<void> {
    return ramRmdir(this.accessor, path)
  }

  override rmR(path: PathSpec): Promise<void> {
    return ramRmR(this.accessor, path)
  }

  override rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return ramRename(this.accessor, src, dst)
  }

  override copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return ramCopy(this.accessor, src, dst)
  }

  override truncate(path: PathSpec, length: number, noCreate = false): Promise<void> {
    return ramTruncate(this.accessor, path, length, noCreate)
  }

  override setattr(
    path: PathSpec,
    fields: SetAttrFields,
  ): Promise<Record<string, number | string>> {
    return ramSetAttrs(this.accessor, path, fields)
  }

  override getState(): RAMVFSState {
    const files: Record<string, Uint8Array> = {}
    for (const [k, v] of this.store.files) files[k] = v
    const modified: Record<string, string> = {}
    for (const [k, v] of this.store.modified) modified[k] = v
    const attrs: Record<string, RAMAttrs> = {}
    for (const [k, v] of this.store.attrs) attrs[k] = { ...v }
    return {
      type: this.name,
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
