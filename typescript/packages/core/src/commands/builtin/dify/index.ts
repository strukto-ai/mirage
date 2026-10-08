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

import type { DifyAccessor } from '../../../accessor/dify.ts'
import { stat, statLight } from '../../../core/dify/stat.ts'
import { DIFY_TREE } from '../../../core/dify/tree.ts'
import { VFSName } from '../../../types.ts'
import type { Command } from '../../config.ts'
import { genericCommands } from '../generic_bind/index.ts'
import { makeFind, readsTimes } from '../slug_tree/find.ts'
import { DIFY_SEARCH } from './search.ts'

export const DIFY_COMMANDS: readonly Command[] = [
  ...genericCommands(VFSName.DIFY, {
    overrides: new Set(['find']),
    // ls stats every listed entry, so it keeps the index-only stat instead
    // of paying one document-detail call per row, as python does.
    adapt: { ls: (io) => ({ ...io, stat: (a, p, i) => statLight(a as DifyAccessor, p, i) }) },
  }),
  ...makeFind(VFSName.DIFY, DIFY_TREE, stat, statLight, readsTimes),
  ...DIFY_SEARCH,
]
