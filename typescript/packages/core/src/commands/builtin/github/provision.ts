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

import type { Accessor } from '../../../accessor/base.ts'
import { Precision, ProvisionResult } from '../../../provision/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'

export function metadataProvision(
  _accessor: Accessor,
  paths: PathSpec[],
  _texts: string[],
  _opts: CommandOpts,
): ProvisionResult {
  const n = Math.max(1, paths.length > 0 ? paths.length : 1)
  return new ProvisionResult({
    networkReadLow: 0,
    networkReadHigh: 0,
    readOps: n,
    precision: Precision.EXACT,
  })
}
