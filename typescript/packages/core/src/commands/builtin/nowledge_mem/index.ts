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

import type { RegisteredCommand } from '../../config.ts'
import { NOWLEDGE_MEM_CAT } from './cat.ts'
import { NOWLEDGE_MEM_FIND } from './find.ts'
import { NOWLEDGE_MEM_GREP } from './grep.ts'
import { NOWLEDGE_MEM_LS } from './ls.ts'
import { NOWLEDGE_MEM_RECALL } from './recall.ts'
import { NOWLEDGE_MEM_STAT } from './stat.ts'

export const NOWLEDGE_MEM_COMMANDS: readonly RegisteredCommand[] = [
  ...NOWLEDGE_MEM_LS,
  ...NOWLEDGE_MEM_CAT,
  ...NOWLEDGE_MEM_STAT,
  ...NOWLEDGE_MEM_FIND,
  ...NOWLEDGE_MEM_GREP,
  ...NOWLEDGE_MEM_RECALL,
]
