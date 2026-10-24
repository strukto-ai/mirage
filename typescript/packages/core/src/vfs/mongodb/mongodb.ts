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
import { streamAny as mongodbStream } from '../../core/mongodb/read.ts'
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
import { BaseVFS } from '../base.ts'
import type { Handed } from '../types.ts'

export const VFS_MD = `{prefix}
  <database>/
    database.json                  collection and view names
    collections/<collection>/
      schema.json                  sampled field types, validator, indexes
      documents.jsonl              streamed BSON Extended JSON documents
    views/<view>/
      schema.json
      documents.jsonl
  Read database.json first to discover entities. Use schema.json before
  reading large document streams; head, tail, wc, grep, rg, and jq understand
  documents.jsonl; grep and rg fetch only the documents that may match.
  Unknown stat sizes display as -; wc -c measures bytes and wc -l counts
  documents on demand. These counts may scan the collection.`

/**
 * MongoDB's functions over its accessor, which the node and browser
 * packages build over their own transport.
 */
export class MongoDBVFSBase extends BaseVFS<MongoDBAccessor> {
  override readonly handed = {
    stat: ['entry'],
  } as const

  override readdir(path: PathSpec): Promise<FileStat[] | DirListing> {
    return mongodbReaddir(this.accessor, path)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async read(path: PathSpec): Promise<ByteSource> {
    return mongodbStream(this.accessor, path)
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return mongodbStat(this.accessor, path, handed?.entry)
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
