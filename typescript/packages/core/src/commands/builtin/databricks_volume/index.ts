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
import { readBytes as databricksRead } from '../../../core/databricks_volume/read.ts'
import { stat as databricksStat } from '../../../core/databricks_volume/stat.ts'
import { ResourceName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeFiletypeCommands } from '../filetype_factory/factory.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { DATABRICKS_VOLUME_IO } from './io.ts'

export const DATABRICKS_VOLUME_COMMANDS: readonly RegisteredCommand[] = [
  ...makeFiletypeCommands<DatabricksVolumeAccessor>({
    resource: ResourceName.DATABRICKS_VOLUME,
    readBytes: databricksRead,
    statEntry: databricksStat,
  }),
  ...makeGenericCommands<DatabricksVolumeAccessor>(
    ResourceName.DATABRICKS_VOLUME,
    DATABRICKS_VOLUME_IO,
  ),
]
