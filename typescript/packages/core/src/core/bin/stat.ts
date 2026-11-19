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

import type { BinAccessor } from '../../accessor/bin.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { read } from './read.ts'

// A program's file is executable by everyone, and the directory holding
// them is the usual /usr/bin.
const PROGRAM_MODE = 0o755

/** Stat the view root, or one program's file sized to its stub. */
export async function stat(accessor: BinAccessor, path: PathSpec): Promise<FileStat> {
  const key = stripSlash(path.mountPath)
  if (key === '') {
    return new FileStat({
      name: 'bin',
      type: FileType.DIRECTORY,
      mode: PROGRAM_MODE,
      modified: accessor.made,
      nlink: 2,
    })
  }
  const data = await read(accessor, path)
  return new FileStat({
    name: key,
    size: data.byteLength,
    type: FileType.FILE,
    mode: PROGRAM_MODE,
    modified: accessor.made,
    nlink: 1,
  })
}
