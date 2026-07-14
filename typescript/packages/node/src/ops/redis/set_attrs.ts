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
import type { RedisAccessor } from '../../accessor/redis.ts'
import { setAttrs as coreSetAttrs, type SetAttrsFields } from '../../core/redis/set_attrs.ts'

export const setAttrsOp: RegisteredOp = {
  name: 'setattr',
  resource: ResourceName.REDIS,
  filetype: null,
  write: true,
  fn: async (accessor: RedisAccessor, path: PathSpec, _args: readonly unknown[], kwargs) => {
    await coreSetAttrs(accessor, path, kwargs as SetAttrsFields)
    return true
  },
}
