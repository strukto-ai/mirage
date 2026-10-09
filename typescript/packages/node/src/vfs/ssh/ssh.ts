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

import { BaseVFS } from '@struktoai/mirage-core/vfs/base'

import { VFSName } from '@struktoai/mirage-core/types'

import { SSHAccessor } from '../../accessor/ssh.ts'

import { type SSHConfig, type SSHConfigRedacted, redactSshConfig } from './config.ts'
import { PROMPT } from './prompt.ts'
import { type DeltaHook } from '@struktoai/mirage-core/watch/index'
import { buildDeltaHook } from '../../core/ssh/watch.ts'
import type { PathSpec, FileStat, SetAttrFields } from '@struktoai/mirage-core/types'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import type { FindOptions } from '@struktoai/mirage-core/vfs/types'
import type { DuEntries, MkdirOp } from '@struktoai/mirage-core/vfs/types'
import { readdir as sshReaddir } from '../../core/ssh/readdir.ts'
import { read as sshRead } from '../../core/ssh/read.ts'
import { stat as sshStat } from '../../core/ssh/stat.ts'
import { readStream as sshStream } from '../../core/ssh/stream.ts'
import { exists as sshExists } from '../../core/ssh/exists.ts'
import { find as sshFind } from '../../core/ssh/find.ts'
import { size as sshDu, entries as sshDuAll } from '../../core/ssh/du/index.ts'
import { write as sshWrite } from '../../core/ssh/write.ts'
import { appendBytes as sshAppend } from '../../core/ssh/append.ts'
import { pwrite as sshPwrite } from '../../core/ssh/pwrite.ts'
import { create as sshCreate } from '../../core/ssh/create.ts'
import { mkdir as sshMkdir } from '../../core/ssh/mkdir.ts'
import { unlink as sshUnlink } from '../../core/ssh/unlink.ts'
import { rmdir as sshRmdir } from '../../core/ssh/rmdir.ts'
import { rmR as sshRmR } from '../../core/ssh/rm.ts'
import { rename as sshRename } from '../../core/ssh/rename.ts'
import { copy as sshCopy } from '../../core/ssh/copy.ts'
import { truncate as sshTruncate } from '../../core/ssh/truncate.ts'
import { setAttrs as sshSetAttrs } from '../../core/ssh/set_attrs.ts'
import { SCOPE_ERROR } from '../../core/ssh/constants.ts'

const mkdirOp: MkdirOp<SSHAccessor> = (accessor, path, parents) =>
  sshMkdir(accessor, path, parents === true)

export interface SSHVFSState {
  type: string
  config: SSHConfigRedacted
}

export class SSHVFS extends BaseVFS {
  override readonly name = VFSName.SSH
  override readonly cachesReads: boolean = true
  // SFTP stat/readdir report the remote inode's exact byte size for every
  // file; reads are the same raw bytes.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly maxDuEntries: number | null = null
  override readonly indexTtl: number = 60
  override readonly prompt = PROMPT
  readonly config: SSHConfig
  override readonly accessor: SSHAccessor

  constructor(config: SSHConfig) {
    super()
    this.config = config
    this.accessor = new SSHAccessor(config)
  }

  override async close(): Promise<void> {
    await this.accessor.close()
    await super.close()
  }

  override readonly readsRanges: boolean = true

  override readonly maxGlobMatches: number = SCOPE_ERROR

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return sshReaddir(this.accessor, path, index)
  }

  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) return sshRead(this.accessor, path, index)
    return sshRead(this.accessor, path, index, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec, _index?: IndexCacheStore): Promise<FileStat> {
    return sshStat(this.accessor, path)
  }

  override readStream(path: PathSpec, _index?: IndexCacheStore): AsyncIterable<Uint8Array> {
    return sshStream(this.accessor, path)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return sshExists(this.accessor, path)
  }

  override find(path: PathSpec, options: FindOptions, _index?: IndexCacheStore): Promise<string[]> {
    return sshFind(this.accessor, path, options)
  }

  override duSize(path: PathSpec, _index?: IndexCacheStore): Promise<number> {
    return sshDu(this.accessor, path)
  }

  override duEntries(path: PathSpec, _index?: IndexCacheStore): Promise<DuEntries> {
    return sshDuAll(this.accessor, path)
  }

  override write(path: PathSpec, data: Uint8Array): Promise<void> {
    return sshWrite(this.accessor, path, data)
  }

  override append(path: PathSpec, data: Uint8Array): Promise<void> {
    return sshAppend(this.accessor, path, data)
  }

  override pwrite(path: PathSpec, data: Uint8Array, offset: number): Promise<void> {
    return sshPwrite(this.accessor, path, data, offset)
  }

  override create(path: PathSpec): Promise<void> {
    return sshCreate(this.accessor, path)
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return mkdirOp(this.accessor, path, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return sshUnlink(this.accessor, path)
  }

  override rmdir(path: PathSpec, _index?: IndexCacheStore): Promise<void> {
    return sshRmdir(this.accessor, path)
  }

  override rmR(path: PathSpec): Promise<void> {
    return sshRmR(this.accessor, path)
  }

  override rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return sshRename(this.accessor, src, dst)
  }

  override copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return sshCopy(this.accessor, src, dst)
  }

  override truncate(path: PathSpec, length: number, noCreate = false): Promise<void> {
    return sshTruncate(this.accessor, path, length, noCreate)
  }

  override setattr(
    path: PathSpec,
    fields: SetAttrFields,
  ): Promise<Record<string, number | string>> {
    return sshSetAttrs(this.accessor, path, fields)
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async getState(): Promise<SSHVFSState> {
    return {
      type: this.name,
      config: redactSshConfig(this.config),
    }
  }
}
