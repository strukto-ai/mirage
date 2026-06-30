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

import type { GSlidesAccessor } from '../../../accessor/gslides.ts'
import { ResourceName } from '../../../types.ts'
import type { ProvisionFn, RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { GSLIDES_GWS_BATCH_UPDATE } from './gws_slides_presentations_batchUpdate.ts'
import { GSLIDES_GWS_CREATE } from './gws_slides_presentations_create.ts'
import { GSLIDES_CMD_OPS } from './ops.ts'
import { fileReadProvision, metadataProvision } from './provision.ts'
import { GSLIDES_RM } from './rm.ts'

export const GSLIDES_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<GSlidesAccessor>(ResourceName.GSLIDES, GSLIDES_CMD_OPS, {
    provisionOverrides: {
      grep: fileReadProvision as ProvisionFn,
      rg: fileReadProvision as ProvisionFn,
      ls: metadataProvision as ProvisionFn,
      find: metadataProvision as ProvisionFn,
    },
  }),
  ...GSLIDES_RM,
  ...GSLIDES_GWS_CREATE,
  ...GSLIDES_GWS_BATCH_UPDATE,
]
