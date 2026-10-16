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

import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { VFSName } from '@struktoai/mirage-core/types'
import { SSHAccessor } from '../../accessor/ssh.ts'
import { type SSHConfig, type SSHConfigRedacted, redactSshConfig } from './config.ts'
import { PROMPT } from './prompt.ts'
import type {
  CapacityResult,
  PathSpec,
  FileStat,
  SetAttrFields,
} from '@struktoai/mirage-core/types'
import type { Handed } from '@struktoai/mirage-core/vfs/types'
import type { MkdirOp } from '@struktoai/mirage-core/vfs/types'
import { readdir as sshReaddir } from '../../core/ssh/readdir.ts'
import { lineCount as sshLineCount, read as sshRead } from '../../core/ssh/read.ts'
import { stat as sshStat, tree as sshTree } from '../../core/ssh/stat.ts'
import { follow as sshFollow, readStream as sshStream } from '../../core/ssh/stream.ts'
import { checksum as sshChecksum } from '../../core/ssh/checksum.ts'
import { exists as sshExists } from '../../core/ssh/exists.ts'
import { filesContaining as sshFilesContaining } from '../../core/ssh/search.ts'
import { write as sshWrite, writeStream as sshWriteStream } from '../../core/ssh/write.ts'
import { appendBytes as sshAppend, appendStream as sshAppendStream } from '../../core/ssh/append.ts'
import { pwrite as sshPwrite } from '../../core/ssh/pwrite.ts'
import { create as sshCreate } from '../../core/ssh/create.ts'
import { mkdir as sshMkdir } from '../../core/ssh/mkdir.ts'
import { unlink as sshUnlink } from '../../core/ssh/unlink.ts'
import { rmdir as sshRmdir } from '../../core/ssh/rmdir.ts'
import { rmR as sshRmR } from '../../core/ssh/rm.ts'
import { rename as sshRename } from '../../core/ssh/rename.ts'
import { copy as sshCopy, dirCopy as sshDirCopy } from '../../core/ssh/copy.ts'
import { capacity as sshCapacity } from '../../core/ssh/capacity.ts'
import { truncate as sshTruncate } from '../../core/ssh/truncate.ts'
import { setAttrs as sshSetAttrs } from '../../core/ssh/set_attrs.ts'
import { SCOPE_ERROR } from '../../core/ssh/constants.ts'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'

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

  override storageLocation(): string {
    // The host, its port and an absolute root pin the files two mounts
    // share, whoever logs in; a relative root starts at the login's own
    // directory, so the login is part of it.
    const cfg = this.config
    const raw = cfg.root ?? '/'
    const login = raw.startsWith('/') ? '' : `${cfg.username ?? ''}@`
    return `${this.name}:${login}${cfg.hostname ?? cfg.host}:${String(cfg.port ?? 22)}${rstripSlash(raw)}`
  }

  override readonly readsRanges: boolean = true

  override readonly maxGlobMatches: number = SCOPE_ERROR

  override readdir(path: PathSpec): Promise<FileStat[]> {
    return sshReaddir(this.accessor, path)
  }

  override read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) return sshRead(this.accessor, path)
    return sshRead(this.accessor, path, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return sshStat(this.accessor, path)
  }

  override readStream(path: PathSpec): AsyncIterable<Uint8Array> {
    return sshStream(this.accessor, path)
  }

  override readTree(path: PathSpec): Promise<Map<string, FileStat> | null> {
    return sshTree(this.accessor, path)
  }

  override lineCount(path: PathSpec): Promise<number | null> {
    return sshLineCount(this.accessor, path)
  }

  override checksum(path: PathSpec, algorithm: string): Promise<string | null> {
    return sshChecksum(this.accessor, path, algorithm)
  }

  override follow(
    path: PathSpec,
    n: number,
    interval: number,
  ): Promise<AsyncIterable<Uint8Array> | null> {
    return sshFollow(this.accessor, path, n, interval)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return sshExists(this.accessor, path)
  }

  override filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    return sshFilesContaining(this.accessor, text, [path], opts.ignoreCase)
  }

  override write(path: PathSpec, data: Uint8Array): Promise<void> {
    return sshWrite(this.accessor, path, data)
  }

  override writeStream(
    path: PathSpec,
    data: ByteSource,
    signal?: AbortSignal,
    atomic = false,
  ): Promise<void> {
    return sshWriteStream(this.accessor, path, data, signal, atomic)
  }

  override appendStream(path: PathSpec, data: ByteSource, signal?: AbortSignal): Promise<void> {
    return sshAppendStream(this.accessor, path, data, signal)
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

  override rmdir(path: PathSpec): Promise<void> {
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

  override dirCopy(src: PathSpec, dst: PathSpec): Promise<void> {
    return sshDirCopy(this.accessor, src, dst)
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

  override capacity(): Promise<CapacityResult> {
    return sshCapacity(this.accessor)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async getState(): Promise<SSHVFSState> {
    return {
      type: this.name,
      config: redactSshConfig(this.config),
    }
  }
}
