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
import { QDRANT_CAT } from './cat.ts'
import { QDRANT_FIND } from './find.ts'
import { QDRANT_GREP } from './grep.ts'
import { QDRANT_HEAD } from './head.ts'
import { QDRANT_LS } from './ls.ts'
import { QDRANT_RG } from './rg.ts'
import { QDRANT_SEARCH } from './search.ts'
import { QDRANT_STAT } from './stat.ts'
import { QDRANT_TAIL } from './tail.ts'
import { QDRANT_TREE } from './tree.ts'
import { QDRANT_WC } from './wc.ts'

export const QDRANT_COMMANDS: readonly RegisteredCommand[] = [
  ...QDRANT_LS,
  ...QDRANT_STAT,
  ...QDRANT_CAT,
  ...QDRANT_TREE,
  ...QDRANT_WC,
  ...QDRANT_FIND,
  ...QDRANT_SEARCH,
  ...QDRANT_GREP,
  ...QDRANT_RG,
  ...QDRANT_HEAD,
  ...QDRANT_TAIL,
]
