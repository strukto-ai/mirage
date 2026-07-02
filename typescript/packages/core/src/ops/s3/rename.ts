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

import type { RegisteredOp } from '../../ops/registry.ts'
import { type PathSpec, ResourceName } from '../../types.ts'
import { rename as coreRename } from '../../core/s3/rename.ts'
import type { S3Accessor } from '../../accessor/s3.ts'

export const renameOp: RegisteredOp = {
  name: 'rename',
  resource: ResourceName.S3,
  filetype: null,
  write: true,
  fn: (accessor: S3Accessor, path: PathSpec, args: readonly unknown[]) => {
    const dst = args[0]
    if (dst === null || typeof dst !== 'object' || !('virtual' in dst)) {
      throw new TypeError('rename op requires a dst PathSpec as the first arg')
    }
    return coreRename(accessor, path, dst as PathSpec)
  },
}
