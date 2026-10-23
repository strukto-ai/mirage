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
import { LOCAL_FULL_SCAN_LIMIT } from '../constants.ts'
import { VFSConfigError } from '../errors.ts'
import { PROMPT } from './prompt.ts'
import { RAMStore, type RAMAttrs } from './store.ts'
import type { PathSpec, FileStat, SetAttrFields } from '../../types.ts'
import type { Handed } from '../types.ts'
import { readdir as ramReaddir } from '../../core/ram/readdir.ts'
import { read as devAwareRead, readRange as devAwareReadRange } from '../../core/dev/read.ts'
import { stat as devAwareStat } from '../../core/dev/stat.ts'
import { readStream as ramStream } from '../../core/ram/stream.ts'
import { exists as ramExists } from '../../core/ram/exists.ts'
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
import { tree as ramTree } from '../../core/ram/readdir.ts'

export interface RAMVFSState {
  type: string
  config?: { full_scan_limit: number }
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

  override readonly fullScanLimit: number

  /**
   * @param options.fullScanLimit the most files one command walks under a directory: searches and
   *   listings stop there, and a glob matching more, tar -c, cp -r, rm -r and the like are refused;
   *   -1 for no cap.
   */
  constructor(options: { fullScanLimit?: number } = {}) {
    super()
    const limit = options.fullScanLimit ?? LOCAL_FULL_SCAN_LIMIT
    if (!Number.isInteger(limit) || limit < -1) {
      throw new VFSConfigError('ram: full_scan_limit: must be an integer of -1 or more')
    }
    this.fullScanLimit = limit
  }

  override readTree(path: PathSpec): Promise<Map<string, FileStat> | null> {
    return ramTree(this.accessor, path)
  }

  override readdir(path: PathSpec): Promise<FileStat[]> {
    return ramReaddir(this.accessor, path)
  }

  override read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) return devAwareRead(this.accessor, path, signal)
    return devAwareReadRange(this.accessor, path, offset, size, signal)
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return devAwareStat(this.accessor, path)
  }

  override readStream(path: PathSpec): AsyncIterable<Uint8Array> {
    return ramStream(this.accessor, path)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return ramExists(this.accessor, path)
  }

  override write(path: PathSpec, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    return ramWrite(this.accessor, path, data, signal)
  }

  override append(
    path: PathSpec,
    data: Uint8Array,
    _handed?: Handed,
    signal?: AbortSignal,
  ): Promise<void> {
    return ramAppend(this.accessor, path, data, signal)
  }

  override pwrite(
    path: PathSpec,
    data: Uint8Array,
    offset: number,
    _handed?: Handed,
    signal?: AbortSignal,
  ): Promise<void> {
    return ramPwrite(this.accessor, path, data, offset, signal)
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

  override rmdir(path: PathSpec): Promise<void> {
    return ramRmdir(this.accessor, path)
  }

  override rmR(path: PathSpec): Promise<void> {
    return ramRmR(this.accessor, path)
  }

  override rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return ramRename(this.accessor, src, dst)
  }

  override copy(src: PathSpec, dst: PathSpec, signal?: AbortSignal): Promise<void> {
    return ramCopy(this.accessor, src, dst, signal)
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
      config: { full_scan_limit: this.fullScanLimit },
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
