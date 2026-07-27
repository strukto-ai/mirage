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

import { IOResult, ResourceName, command, runDu, specOf } from '@struktoai/mirage-core'
import { size as opfsDu, entries as opfsDuAll } from '../../../core/opfs/du/index.ts'
import { stat as opfsStat } from '../../../core/opfs/stat.ts'
import type { OPFSAccessor } from '../../../accessor/opfs.ts'

export const OPFS_DU = command({
  name: 'du',
  resource: ResourceName.OPFS,
  spec: specOf('du'),
  fn: async (accessor: OPFSAccessor, paths, _texts, opts) => {
    const out = await runDu(
      paths,
      opts,
      (targets) => Promise.resolve(targets),
      (p) => opfsStat(accessor, p),
      (p) => opfsDu(accessor, p),
      (p) => opfsDuAll(accessor, p),
    )
    return [out.stdout, new IOResult({ stderr: out.stderr, exitCode: out.exitCode })]
  },
})
