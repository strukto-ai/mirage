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

import type { NotionAccessor } from '../../../accessor/notion.ts'
import type { IndexCacheStore } from '../../../cache/index/index.ts'
import { read as notionRead } from '../../../core/notion/read.ts'
import { readdir as notionReaddir } from '../../../core/notion/readdir.ts'
import { stat as notionStat } from '../../../core/notion/stat.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandIO } from '../generic_bind/index.ts'

async function* notionReadStream(
  accessor: NotionAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await notionRead(accessor, path, index)
}

export const NOTION_CMD_OPS: CommandIO<NotionAccessor> = {
  readdir: notionReaddir,
  readBytes: notionRead,
  readStream: notionReadStream,
  stat: notionStat,
  isMounted: () => true,
  local: false,
}
