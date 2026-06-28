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

import type { GDriveAccessor } from '../../../accessor/gdrive.ts'
import { read as gdriveRead } from '../../../core/gdrive/read.ts'
import { stat as gdriveStat } from '../../../core/gdrive/stat.ts'
import { ResourceName } from '../../../types.ts'
import type { ProvisionFn, RegisteredCommand } from '../../config.ts'
import { makeFiletypeCommands } from '../filetype_factory/factory.ts'
import { GDOCS_COMMANDS } from '../gdocs/index.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { GSHEETS_COMMANDS } from '../gsheets/index.ts'
import { GSLIDES_COMMANDS } from '../gslides/index.ts'
import { GDRIVE_CMD_OPS } from './ops.ts'
import { fileReadProvision, metadataProvision } from './provision.ts'
import { GDRIVE_SED } from './sed.ts'

const GWS_FOR_GDRIVE: readonly RegisteredCommand[] = [
  ...GDOCS_COMMANDS.filter((c) => c.resource === ResourceName.GDRIVE),
  ...GSHEETS_COMMANDS.filter((c) => c.resource === ResourceName.GDRIVE),
  ...GSLIDES_COMMANDS.filter((c) => c.resource === ResourceName.GDRIVE),
]

export const GDRIVE_COMMANDS: readonly RegisteredCommand[] = [
  ...makeFiletypeCommands<GDriveAccessor>({
    resource: ResourceName.GDRIVE,
    readBytes: gdriveRead,
    statEntry: gdriveStat,
  }),
  ...makeGenericCommands<GDriveAccessor>(ResourceName.GDRIVE, GDRIVE_CMD_OPS, {
    provisionOverrides: {
      grep: fileReadProvision as ProvisionFn,
      rg: fileReadProvision as ProvisionFn,
      ls: metadataProvision as ProvisionFn,
      find: metadataProvision as ProvisionFn,
    },
  }),
  ...GDRIVE_SED,
  ...GWS_FOR_GDRIVE,
]
