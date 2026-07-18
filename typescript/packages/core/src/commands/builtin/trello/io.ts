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

import type { TrelloAccessor } from '../../../accessor/trello.ts'
import { read as trelloRead } from '../../../core/trello/read.ts'
import { readdir as trelloReaddir } from '../../../core/trello/readdir.ts'
import { stat as trelloStat } from '../../../core/trello/stat.ts'
import type { CommandIO } from '../generic_bind/index.ts'
import { streamFromBytes } from '../utils/wrap.ts'

export const TRELLO_IO: CommandIO<TrelloAccessor> = {
  readdir: trelloReaddir,
  readBytes: trelloRead,
  readStream: (a, p, i) => streamFromBytes(trelloRead, a, p, i),
  stat: trelloStat,
  isMounted: () => true,
  local: false,
}
