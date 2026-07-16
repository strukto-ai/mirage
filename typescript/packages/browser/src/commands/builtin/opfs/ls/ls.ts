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

import { ResourceName, command, lsGeneric, specOf } from '@struktoai/mirage-core'
import type { PathSpec } from '@struktoai/mirage-core'
import { stat as opfsStat } from '../../../../core/opfs/stat.ts'
import { readdir as opfsReaddir } from '../../../../core/opfs/readdir.ts'
import type { OPFSAccessor } from '../../../../accessor/opfs.ts'

export const OPFS_LS = command({
  name: 'ls',
  resource: ResourceName.OPFS,
  spec: specOf('ls'),
  fn: (accessor: OPFSAccessor, paths, _texts, opts) => {
    const overlay = opts.statOverlay
    // ls renders stat rows the backend produces, which never see the
    // namespace attr overlay (chmod/chown/touch on overlay backends);
    // merge it in so ls -l matches the ops facade.
    const stat =
      overlay !== undefined
        ? async (p: PathSpec) => overlay(p.virtual, await opfsStat(accessor, p))
        : (p: PathSpec) => opfsStat(accessor, p)
    return lsGeneric(paths, opts, (p) => opfsReaddir(accessor, p), stat)
  },
})
