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

import type { OpKwargs, RegisteredOp } from '../../ops/registry.ts'
import { type PathSpec, ResourceName } from '../../types.ts'
import { rename as coreRename } from '../../core/databricks_volume/rename.ts'
import type { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'

export const renameOp: RegisteredOp = {
  name: 'rename',
  resource: ResourceName.DATABRICKS_VOLUME,
  filetype: null,
  write: true,
  fn: (
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    args: readonly unknown[],
    kwargs: OpKwargs,
  ) => {
    const dst = args[0]
    if (dst === null || typeof dst !== 'object' || !('virtual' in dst)) {
      throw new TypeError('rename op requires a dst PathSpec as the first arg')
    }
    return coreRename(accessor, path, dst as PathSpec, kwargs.index)
  },
}
