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

import type { MongoDBAccessor } from '../../accessor/mongodb.ts'
import { read as mongodbRead, streamAny as mongodbStream } from '../../core/mongodb/read.ts'
import { readdir as mongodbReaddir } from '../../core/mongodb/readdir.ts'
import { linesContaining as mongodbLinesContaining } from '../../core/mongodb/search.ts'
import { stat as mongodbStat } from '../../core/mongodb/stat.ts'
import {
  follow as mongodbFollow,
  lastLines as mongodbLastLines,
  lineCount as mongodbLineCount,
} from '../../core/mongodb/stream.ts'
import type { ByteSource } from '../../io/types.ts'
import type { DirListing, FileStat, PathSpec } from '../../types.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { BaseVFS } from '../base.ts'
import type { Handed } from '../types.ts'

/**
 * MongoDB's functions over its accessor, which the node and browser
 * packages build over their own transport.
 */
export class MongoDBVFSBase extends BaseVFS<MongoDBAccessor> {
  override readonly listsStats: boolean = true
  override readonly handed = {
    stat: ['entry'],
  } as const

  override readdir(path: PathSpec): Promise<FileStat[] | DirListing> {
    return mongodbReaddir(this.accessor, path)
  }

  override async read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await mongodbRead(this.accessor, path)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return mongodbStat(this.accessor, path, handed?.entry)
  }

  override readStream(path: PathSpec): AsyncIterable<Uint8Array> {
    return mongodbStream(this.accessor, path)
  }

  override linesContaining(path: PathSpec, text: string): Promise<ByteSource | null> {
    return mongodbLinesContaining(this.accessor, path, text)
  }

  override lastLines(path: PathSpec, n: number): Promise<Uint8Array | null> {
    return mongodbLastLines(this.accessor, path, n)
  }

  override lineCount(path: PathSpec): Promise<number | null> {
    return mongodbLineCount(this.accessor, path)
  }

  override follow(
    path: PathSpec,
    n: number,
    _interval: number,
  ): Promise<AsyncIterable<Uint8Array> | null> {
    return mongodbFollow(this.accessor, path, n)
  }
}
