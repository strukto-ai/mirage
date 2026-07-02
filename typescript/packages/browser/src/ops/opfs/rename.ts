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

import type { PathSpec, RegisteredOp } from '@struktoai/mirage-core'
import { ResourceName } from '@struktoai/mirage-core'
import type { OPFSAccessor } from '../../accessor/opfs.ts'
import { rename as coreRename } from '../../core/opfs/rename.ts'

export const renameOp: RegisteredOp = {
  name: 'rename',
  resource: ResourceName.OPFS,
  filetype: null,
  write: true,
  fn: (accessor: OPFSAccessor, path: PathSpec, args: readonly unknown[]) => {
    const dst = args[0]
    if (dst === undefined || dst === null || typeof dst !== 'object' || !('virtual' in dst)) {
      throw new TypeError('rename op requires a PathSpec destination as the first arg')
    }
    return coreRename(accessor, path, dst as PathSpec)
  },
}
