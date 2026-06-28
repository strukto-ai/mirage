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

import type { Builder } from '../adapter.ts'
import { CAT_BUILDER } from './cat.ts'
import { DU_BUILDER } from './du.ts'
import { FILE_BUILDER } from './file.ts'
import { FIND_BUILDER } from './find.ts'
import { HEAD_BUILDER } from './head.ts'
import { LS_BUILDER } from './ls.ts'
import { NL_BUILDER } from './nl.ts'
import { REV_BUILDER } from './rev.ts'
import { STAT_BUILDER } from './stat.ts'
import { TAC_BUILDER } from './tac.ts'
import { TAIL_BUILDER } from './tail.ts'
import { TREE_BUILDER } from './tree.ts'
import { WC_BUILDER } from './wc.ts'

export const BUILDERS: readonly Builder[] = [
  CAT_BUILDER,
  HEAD_BUILDER,
  TAIL_BUILDER,
  WC_BUILDER,
  NL_BUILDER,
  TAC_BUILDER,
  REV_BUILDER,
  FILE_BUILDER,
  LS_BUILDER,
  STAT_BUILDER,
  DU_BUILDER,
  FIND_BUILDER,
  TREE_BUILDER,
]
