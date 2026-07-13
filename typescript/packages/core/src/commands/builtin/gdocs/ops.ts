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

import type { GDocsAccessor } from '../../../accessor/gdocs.ts'
import { read as gdocsRead, stream as gdocsStream } from '../../../core/gdocs/read.ts'
import { isDirName, readdir as gdocsReaddir } from '../../../core/gdocs/readdir.ts'
import { stat as gdocsStat } from '../../../core/gdocs/stat.ts'
import type { CommandIO } from '../generic_bind/index.ts'

export const GDOCS_CMD_OPS: CommandIO<GDocsAccessor> = {
  readdir: gdocsReaddir,
  readBytes: gdocsRead,
  readStream: gdocsStream,
  stat: gdocsStat,
  isMounted: () => true,
  isDirName: (_accessor, child) => isDirName(child),
  local: false,
}
