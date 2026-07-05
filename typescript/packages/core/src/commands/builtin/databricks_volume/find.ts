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

import type { DatabricksVolumeAccessor } from '../../../accessor/databricks_volume.ts'
import { find as dbxFind } from '../../../core/databricks_volume/find.ts'
import { ResourceName } from '../../../types.ts'
import { command } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { findGeneric } from '../generic/find.ts'
import { metadataProvision } from '../generic_bind/provision.ts'

export const DATABRICKS_VOLUME_FIND = command({
  name: 'find',
  resource: ResourceName.DATABRICKS_VOLUME,
  spec: specOf('find'),
  fn: (accessor: DatabricksVolumeAccessor, paths, texts, opts) =>
    findGeneric(paths, texts, opts, (root, options) =>
      dbxFind(accessor, root, options, opts.index ?? undefined),
    ),
  provision: metadataProvision,
})
