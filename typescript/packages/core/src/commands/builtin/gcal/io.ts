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

import type { GCalAccessor } from '../../../accessor/gcal.ts'
import { read as gcalRead } from '../../../core/gcal/read.ts'
import { readdir as gcalReaddir } from '../../../core/gcal/readdir.ts'
import { stat as gcalStat } from '../../../core/gcal/stat.ts'
import type { CommandIO } from '../generic_bind/index.ts'
import { streamFromBytes } from '../utils/wrap.ts'

export const GCAL_IO: CommandIO<GCalAccessor> = {
  readdir: gcalReaddir,
  readBytes: gcalRead,
  readStream: (a, p, i) => streamFromBytes(gcalRead, a, p, i),
  stat: gcalStat,
  isMounted: () => true,
  local: false,
}
