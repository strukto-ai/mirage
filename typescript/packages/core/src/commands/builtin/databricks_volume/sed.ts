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
import { resolveGlob } from '../../../core/databricks_volume/glob.ts'
import { stat as databricksProvStat } from '../../../core/databricks_volume/stat.ts'
import { readStream as dbxStream } from '../../../core/databricks_volume/stream.ts'
import { writeBytes as dbxWrite } from '../../../core/databricks_volume/write.ts'
import { ResourceName } from '../../../types.ts'
import { makeSed } from '../generic/sed_command.ts'

export const DATABRICKS_VOLUME_SED = makeSed<DatabricksVolumeAccessor>({
  stat: (a, p) => databricksProvStat(a, p),
  resource: ResourceName.DATABRICKS_VOLUME,
  stream: (a, p) => dbxStream(a, p),
  write: (a, p, d) => dbxWrite(a, p, d),
  glob: (a, paths, opts) => resolveGlob(a, paths, opts.index ?? undefined),
})
