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
import { ResourceName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { DATABRICKS_VOLUME_FIND } from './find.ts'
import { DATABRICKS_VOLUME_HEAD } from './head.ts'
import { DATABRICKS_VOLUME_MKDIR } from './mkdir.ts'
import { DATABRICKS_VOLUME_CMD_OPS } from './ops.ts'
import { DATABRICKS_VOLUME_RM } from './rm.ts'
import { DATABRICKS_VOLUME_SED } from './sed.ts'
import { DATABRICKS_VOLUME_TOUCH } from './touch.ts'

const DATABRICKS_VOLUME_OVERRIDES = new Set(['head', 'sed', 'mkdir', 'touch', 'rm', 'find'])

export const DATABRICKS_VOLUME_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<DatabricksVolumeAccessor>(
    ResourceName.DATABRICKS_VOLUME,
    DATABRICKS_VOLUME_CMD_OPS,
    {
      overrides: DATABRICKS_VOLUME_OVERRIDES,
    },
  ),
  ...DATABRICKS_VOLUME_FIND,
  ...DATABRICKS_VOLUME_HEAD,
  ...DATABRICKS_VOLUME_MKDIR,
  ...DATABRICKS_VOLUME_TOUCH,
  ...DATABRICKS_VOLUME_RM,
  ...DATABRICKS_VOLUME_SED,
]
