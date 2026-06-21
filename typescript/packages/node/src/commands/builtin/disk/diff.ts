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

import { ResourceName, command, diffGeneric, specOf } from '@struktoai/mirage-core'
import { stream as diskStream } from '../../../core/disk/stream.ts'
import { readdir as diskReaddir } from '../../../core/disk/readdir.ts'
import { stat as diskStat } from '../../../core/disk/stat.ts'
import type { DiskAccessor } from '../../../accessor/disk.ts'

export const DISK_DIFF = command({
  name: 'diff',
  resource: ResourceName.DISK,
  spec: specOf('diff'),
  fn: (accessor: DiskAccessor, paths, _texts, opts) =>
    diffGeneric(
      paths,
      opts,
      (p) => diskStream(accessor, p),
      (p) => diskReaddir(accessor, p, opts.index ?? undefined),
      (p) => diskStat(accessor, p),
    ),
})
