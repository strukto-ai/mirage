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

import type { GSheetsAccessor } from '../../../accessor/gsheets.ts'
import { read as gsheetsRead, stream as gsheetsStream } from '../../../core/gsheets/read.ts'
import { readdir as gsheetsReaddir } from '../../../core/gsheets/readdir.ts'
import { stat as gsheetsStat } from '../../../core/gsheets/stat.ts'
import type { CommandIO } from '../generic_bind/index.ts'

export const GSHEETS_CMD_OPS: CommandIO<GSheetsAccessor> = {
  readdir: gsheetsReaddir,
  readBytes: gsheetsRead,
  readStream: gsheetsStream,
  stat: gsheetsStat,
  isMounted: () => true,
  local: false,
}
