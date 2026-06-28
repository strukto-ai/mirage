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

import type { QdrantAccessor } from '../../accessor/qdrant.ts'
import { readdir as coreReaddir } from '../../core/qdrant/readdir.ts'
import { ResourceName } from '../../types.ts'
import type { OpKwargs, RegisteredOp } from '../registry.ts'

export const readdirOp: RegisteredOp = {
  name: 'readdir',
  resource: ResourceName.QDRANT,
  filetype: null,
  write: false,
  fn: (accessor, path, _args, kwargs: OpKwargs) => {
    return coreReaddir(accessor as QdrantAccessor, path, kwargs.index)
  },
}
