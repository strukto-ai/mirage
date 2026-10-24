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

import type { LanceDBAccessor } from '../../accessor/lancedb.ts'
import { filesContaining } from '../../core/lancedb/search.ts'
import { SEARCH, read, readdir, stat } from '../../core/lancedb/tree.ts'
import type { DirListing, FileStat, PathSpec, SearchQuery } from '../../types.ts'
import { BaseVFS } from '../base.ts'

export const VFS_MD = `This mount is a LanceDB table exposed as a filesystem.

Directories are the configured group-by columns; descending narrows a filter.
Each matching row is a <id>.md card plus a <id>.<ext> blob file. For semantic
search use the search command, which returns ranked rows as canonical file
paths with a score, e.g. search "red running shoes" /mount then cat one of the
returned <path>.md files. Use ls/cd/cat/tree/find/wc as usual; grep/rg stay
lexical. Quote queries that contain spaces.`

/**
 * LanceDB's functions over its accessor, which a host package builds
 * over its own transport.
 */
export class LanceDBVFSBase extends BaseVFS<LanceDBAccessor> {
  override readdir(path: PathSpec): Promise<FileStat[] | DirListing> {
    return readdir(this.accessor, path)
  }

  override async read(path: PathSpec): Promise<Uint8Array> {
    return read(this.accessor, path)
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return stat(this.accessor, path)
  }

  override filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    return filesContaining(this.accessor, text, [path], opts.wholeWord, opts.ignoreCase)
  }

  override search(path: PathSpec, query: SearchQuery): Promise<[string, string][] | null> {
    return SEARCH.search(this.accessor, path, query)
  }

  override searchMany(paths: PathSpec[], query: SearchQuery): Promise<[string, string][] | null> {
    return SEARCH.searchMany(this.accessor, paths, query)
  }
}
