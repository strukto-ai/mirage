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

import { type ByteSource } from '@struktoai/mirage-core/io/types'
import { ListingVersion } from '@struktoai/mirage-core/types'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'

import type { VFSStateBase } from '@struktoai/mirage-core/vfs/base'

import type { HfHubAccessor } from '../../accessor/hf_hub.ts'

import type { DirListing, PathSpec, FileStat } from '@struktoai/mirage-core/types'
import type { Handed } from '@struktoai/mirage-core/vfs/types'
import { readdir as hubReaddir } from '../../core/hf_hub/readdir.ts'
import { read as hubRead } from '../../core/hf_hub/read.ts'
import { stat as hubStat } from '../../core/hf_hub/stat.ts'
import { readStream as hubStream } from '../../core/hf_hub/stream.ts'
import { exists as hubExists } from '../../core/hf_hub/exists.ts'
import { checksum as hubChecksum } from '../../core/hf_hub/checksum.ts'

/**
 * The shared body of the three Hub *repository* VFS.
 *
 * Separate from `HfBucketsVFS` (vfs/hf_buckets/hf_buckets.ts) on purpose:
 * that one drives OpenDAL against Hugging Face Buckets, which is a different
 * product -- Xet-backed mutable object storage with no commits and no
 * revisions. These three are git repositories, read through the Hub's own
 * tree API and written as commits.
 */

export abstract class HfHubVFS extends BaseVFS {
  abstract override readonly accessor: HfHubAccessor
  // Narrowed back to abstract: all three carry a config and so owe their own
  // redaction, and inheriting BaseVFS's bare `{type}` would drop it and read
  // back as an empty mount.
  abstract override getState(): Promise<VFSStateBase>
  override readonly cachesReads: boolean = true
  // The Hub tree reports every file's exact byte size, and for an LFS file
  // that is the object's own size rather than the pointer's, so no read can
  // be short.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly supportsSnapshot: boolean = true
  override readonly readRevalidatable: boolean = true
  // One version covers every listing: the head commit the revision resolves
  // to, asked with `revision/{rev}?expand[]=sha`, and the tree is walked at
  // that commit so the rows and the version agree. A full-sha revision is
  // checked the same way and never pinned: a branch or tag named like it
  // could take the name, and mirage does not assume which one the Hub
  // resolves.
  override readonly listingVersion: ListingVersion = ListingVersion.MOUNT
  // One recursive fetch lists the whole repository, every folder at the head
  // it was walked at, and the version check catches a moved head. A long TTL
  // therefore spares the Hub a full re-walk rather than risking a stale row.
  override readonly indexTtl: number = 86_400

  override readonly readsRanges: boolean = true

  override readonly handed = {
    read: ['entry'],
    stat: ['entry', 'index'],
    exists: ['entry'],
    checksum: ['entry'],
  } as const

  override readdir(path: PathSpec): Promise<DirListing> {
    return hubReaddir(this.accessor, path)
  }

  override read(
    path: PathSpec,
    handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> | AsyncIterable<Uint8Array> {
    if (offset === 0 && size === null) return hubStream(this.accessor, path, handed?.entry)
    return hubRead(
      this.accessor,
      path,
      size === null ? { offset } : { offset, size },
      handed?.entry,
    )
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return hubStat(this.accessor, path, handed?.entry, handed?.index)
  }

  override exists(path: PathSpec, handed?: Handed): Promise<boolean> {
    return hubExists(this.accessor, path, handed?.entry)
  }

  override checksum(path: PathSpec, algorithm: string, handed?: Handed): Promise<string | null> {
    return hubChecksum(this.accessor, path, algorithm, handed?.entry)
  }
}
