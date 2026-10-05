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

import { VFSAdapter } from '../../../vfs/adapter.ts'

import type { GSheetsAccessor } from '../../../accessor/gsheets.ts'
import { read as gsheetsRead, readStream as gsheetsStream } from '../../../core/gsheets/read.ts'
import { readdir as gsheetsReaddir } from '../../../core/gsheets/readdir.ts'
import { stat as gsheetsStat } from '../../../core/gsheets/stat.ts'
import type { CommandIO } from '../generic_bind/index.ts'

export const IO: CommandIO<GSheetsAccessor> = new VFSAdapter<GSheetsAccessor>({
  read: { readdir: gsheetsReaddir, readBytes: gsheetsRead, stat: gsheetsStat },
  native: { readStream: gsheetsStream },
  isMounted: () => true,
  local: false,
}).toCommandIO()
