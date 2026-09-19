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

import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { FindOptions } from '@struktoai/mirage-core/vfs/base'
import { PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { SSHAccessor } from '../../accessor/ssh.ts'
import { SSH_COMMANDS } from '../../commands/builtin/ssh/index.ts'
import { appendBytes as appendCore } from '../../core/ssh/append.ts'
import { copy as copyCore } from '../../core/ssh/copy.ts'
import { size as duSizeCore } from '../../core/ssh/du/index.ts'
import { exists as existsCore } from '../../core/ssh/exists.ts'
import { find as findCore, type FindOptions as SshFindOptions } from '../../core/ssh/find.ts'
import { mkdir as mkdirCore } from '../../core/ssh/mkdir.ts'
import { read as readCoreFn } from '../../core/ssh/read.ts'
import { SCOPE_ERROR } from '../../core/ssh/constants.ts'
import { readdir as readdirCore } from '../../core/ssh/readdir.ts'
import { rename as renameCore } from '../../core/ssh/rename.ts'
import { rmR as rmRCore } from '../../core/ssh/rm.ts'
import { rmdir as rmdirCore } from '../../core/ssh/rmdir.ts'
import { stat as statCore } from '../../core/ssh/stat.ts'
import { stream as streamCore } from '../../core/ssh/stream.ts'
import { truncate as truncateCore } from '../../core/ssh/truncate.ts'
import { unlink as unlinkCore } from '../../core/ssh/unlink.ts'
import { writeBytes as writeCore } from '../../core/ssh/write.ts'
import { SSH_OPS } from '../../ops/ssh/index.ts'
import { type SSHConfig, type SSHConfigRedacted, redactSshConfig } from './config.ts'
import { SSH_PROMPT } from './prompt.ts'
import { type DeltaHook } from '@struktoai/mirage-core/watch/index'
import { buildDeltaHook } from '../../core/ssh/watch.ts'

const globCore = makeResolveGlob(readdirCore, SCOPE_ERROR)

export interface SSHVFSState {
  type: string
  config: SSHConfigRedacted
}

export class SSHVFS extends BaseVFS {
  readonly name = VFSName.SSH
  override readonly cachesReads: boolean = true
  // SFTP stat/readdir report the remote inode's exact byte size for every
  // file; reads are the same raw bytes.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 60
  override readonly prompt = SSH_PROMPT
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

  override ops(): readonly RegisteredOp[] {
    return SSH_OPS
  }

  override commands(): readonly RegisteredCommand[] {
    return SSH_COMMANDS
  }

  override streamPath(p: PathSpec): AsyncIterable<Uint8Array> {
    return streamCore(this.accessor, p)
  }

  override readFile(p: PathSpec): Promise<Uint8Array> {
    return readCoreFn(this.accessor, p)
  }

  override writeFile(p: PathSpec, data: Uint8Array): Promise<void> {
    return writeCore(this.accessor, p, data)
  }

  override appendFile(p: PathSpec, data: Uint8Array): Promise<void> {
    return appendCore(this.accessor, p, data)
  }

  override readdir(p: PathSpec): Promise<string[]> {
    return readdirCore(this.accessor, p)
  }

  override stat(p: PathSpec): Promise<FileStat> {
    return statCore(this.accessor, p)
  }

  override exists(p: PathSpec): Promise<boolean> {
    return existsCore(this.accessor, p)
  }

  override mkdir(p: PathSpec, options?: { recursive?: boolean }): Promise<void> {
    return mkdirCore(this.accessor, p, options?.recursive === true)
  }

  override rmdir(p: PathSpec): Promise<void> {
    return rmdirCore(this.accessor, p)
  }

  override unlink(p: PathSpec): Promise<void> {
    return unlinkCore(this.accessor, p)
  }

  override rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return renameCore(this.accessor, src, dst)
  }

  override truncate(p: PathSpec, length: number): Promise<void> {
    return truncateCore(this.accessor, p, length)
  }

  override copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return copyCore(this.accessor, src, dst)
  }

  override rmR(p: PathSpec): Promise<void> {
    return rmRCore(this.accessor, p)
  }

  override du(p: PathSpec): Promise<number> {
    return duSizeCore(this.accessor, p)
  }

  override find(p: PathSpec, options: FindOptions = {}): Promise<string[]> {
    return findCore(this.accessor, p, options as SshFindOptions)
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
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
    return globCore(this.accessor, effective)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async getState(): Promise<SSHVFSState> {
    return {
      type: this.name,
      config: redactSshConfig(this.config),
    }
  }

  override loadState(_state: SSHVFSState): Promise<void> {
    return Promise.resolve()
  }
}
