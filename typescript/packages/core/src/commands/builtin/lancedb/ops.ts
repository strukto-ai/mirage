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

import type { LanceDBAccessor } from '../../../accessor/lancedb.ts'
import { read as lancedbRead } from '../../../core/lancedb/read.ts'
import { readdir as lancedbReaddir } from '../../../core/lancedb/readdir.ts'
import { stat as lancedbStat } from '../../../core/lancedb/stat.ts'
import { stream as lancedbStream } from '../../../core/lancedb/stream.ts'
import type { CommandIO } from '../generic_bind/index.ts'

export const LANCEDB_CMD_OPS: CommandIO<LanceDBAccessor> = {
  readdir: lancedbReaddir,
  readBytes: lancedbRead,
  readStream: lancedbStream,
  stat: lancedbStat,
  isMounted: () => true,
  local: false,
}
