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

import type { OpKwargs, RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { ResourceName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import { liveIdentity as coreLiveIdentity } from '../../core/gridfs/identity.ts'

// Bounded identity lookup, bypassing the index cache entirely: `kwargs`
// carries the injected `index` and it is never read.
export const liveIdentityOp: RegisteredOp = {
  name: 'live_identity',
  resource: ResourceName.GRIDFS,
  filetype: null,
  write: false,
  fn: async (
    accessor: GridFSAccessor,
    path: PathSpec,
    _args: readonly unknown[],
    _kwargs: OpKwargs,
  ) => coreLiveIdentity(accessor, path),
}
