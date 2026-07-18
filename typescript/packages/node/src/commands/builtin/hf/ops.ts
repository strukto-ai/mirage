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

import type { CommandIO } from '@struktoai/mirage-core'
import type { HfAccessor } from '../../../accessor/hf.ts'
import { SCOPE_ERROR } from '../../../core/hf/constants.ts'
import { mkdir as hfMkdir } from '../../../core/hf/mkdir.ts'
import { read as hfRead } from '../../../core/hf/read.ts'
import { readdir as hfReaddir } from '../../../core/hf/readdir.ts'
import { stat as hfStat } from '../../../core/hf/stat.ts'
import { stream as hfStream } from '../../../core/hf/stream.ts'
import { exists as hfExists } from '../../../core/hf/exists.ts'
import { write as hfWrite } from '../../../core/hf/write.ts'

export const HF_CMD_OPS: CommandIO<HfAccessor> = {
  readdir: hfReaddir,
  readBytes: hfRead,
  readStream: hfStream,
  stat: hfStat,
  isMounted: () => true,
  local: false,
  maxGlobMatches: SCOPE_ERROR,
  write: hfWrite,
  exists: hfExists,
  mkdir: (accessor, path) => hfMkdir(accessor, path),
}
