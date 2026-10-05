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

import { read, readStream } from '../../../core/dify/read.ts'
import { searchMany, searchResource } from '../../../core/dify/search.ts'
import { stat } from '../../../core/dify/stat.ts'
import { DIFY_TREE } from '../../../core/dify/tree.ts'
import type { DifyAccessor } from '../../../accessor/dify.ts'
import { VFSAdapter } from '../../../vfs/adapter.ts'
import { type CommandIO, rangeOf } from '../generic_bind/index.ts'

// Dify is read-only, so no write op is wired and the generic byte-mutation
// commands are intentionally absent. stat is the full document-detail stat;
// the commands that would multiply that per-entry API call stay cheap
// through lighter routes instead (ls receives a light-stat adapter from the
// package factory, the find wrapper threads statLight unless a time test needs
// detail timestamps), mirroring the Python wiring.
export const IO: CommandIO<DifyAccessor> = new VFSAdapter<DifyAccessor>({
  search: { search: searchResource, searchMany },
  read: { readdir: DIFY_TREE.readdir, readBytes: read, stat },
  native: { readRange: rangeOf(read), readStream },
  isMounted: () => true,
  local: false,
}).toCommandIO()
