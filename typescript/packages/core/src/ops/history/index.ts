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

import type { HistoryAccessor } from '../../accessor/history.ts'
import { read as coreRead } from '../../core/history/read.ts'
import { readdir as coreReaddir } from '../../core/history/readdir.ts'
import { stat as coreStat } from '../../core/history/stat.ts'
import { type PathSpec, ResourceName } from '../../types.ts'
import type { RegisteredOp } from '../registry.ts'

const R = ResourceName.HISTORY

const readOp: RegisteredOp = {
  name: 'read',
  resource: R,
  filetype: null,
  write: false,
  fn: (accessor: HistoryAccessor, path: PathSpec) => coreRead(accessor, path),
}

const statOp: RegisteredOp = {
  name: 'stat',
  resource: R,
  filetype: null,
  write: false,
  fn: (accessor: HistoryAccessor, path: PathSpec) => coreStat(accessor, path),
}

const readdirOp: RegisteredOp = {
  name: 'readdir',
  resource: R,
  filetype: null,
  write: false,
  fn: (accessor: HistoryAccessor, path: PathSpec) => coreReaddir(accessor, path),
}

export const HISTORY_OPS: readonly RegisteredOp[] = [readOp, statOp, readdirOp]
