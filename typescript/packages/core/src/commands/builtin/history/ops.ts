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

import type { HistoryAccessor } from '../../../accessor/history.ts'
import { read as historyRead } from '../../../core/history/read.ts'
import { readdir as historyReaddir } from '../../../core/history/readdir.ts'
import { stat as historyStat } from '../../../core/history/stat.ts'
import { stream as historyStream } from '../../../core/history/stream.ts'
import type { CommandIO } from '../generic_bind/index.ts'

// The history view is read-only (the recorder owns mutation), so only
// the read trio is wired; the history builtin itself stays bespoke.
export const HISTORY_CMD_OPS: CommandIO<HistoryAccessor> = {
  readdir: historyReaddir,
  readBytes: historyRead,
  readStream: historyStream,
  stat: historyStat,
  isMounted: () => true,
  local: false,
}
