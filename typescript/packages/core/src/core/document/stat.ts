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

import type { DocumentAccessor } from '../../accessor/document.ts'
import { FileType, FileStat, type PathSpec } from '../../types.ts'
import { read } from './read.ts'

export async function stat(accessor: DocumentAccessor, path: PathSpec): Promise<FileStat> {
  const data = await read(accessor, path)
  return new FileStat({
    name: accessor.name,
    type: FileType.FILE,
    size: data.byteLength,
    modified: null,
    extra: { 'mirage.live': true },
  })
}
