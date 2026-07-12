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

import type { QdrantAccessor } from '../../../accessor/qdrant.ts'
import { read as qdrantRead } from '../../../core/qdrant/read.ts'
import { isDirName, readdir as qdrantReaddir } from '../../../core/qdrant/readdir.ts'
import { stat as qdrantStat } from '../../../core/qdrant/stat.ts'
import { stream as qdrantStream } from '../../../core/qdrant/stream.ts'
import type { CommandIO } from '../generic_bind/index.ts'

export const QDRANT_CMD_OPS: CommandIO<QdrantAccessor> = {
  readdir: qdrantReaddir,
  readBytes: qdrantRead,
  readStream: qdrantStream,
  stat: qdrantStat,
  isMounted: () => true,
  isDirName: (accessor, child) => isDirName(child, accessor.config),
  local: false,
}
