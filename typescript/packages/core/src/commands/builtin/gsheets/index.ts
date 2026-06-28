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

import type { GSheetsAccessor } from '../../../accessor/gsheets.ts'
import { ResourceName } from '../../../types.ts'
import type { ProvisionFn, RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { GSHEETS_GWS_APPEND } from './gws_sheets_append.ts'
import { GSHEETS_GWS_READ } from './gws_sheets_read.ts'
import { GSHEETS_GWS_BATCH_UPDATE } from './gws_sheets_spreadsheets_batchUpdate.ts'
import { GSHEETS_GWS_CREATE } from './gws_sheets_spreadsheets_create.ts'
import { GSHEETS_GWS_WRITE } from './gws_sheets_write.ts'
import { GSHEETS_CMD_OPS } from './ops.ts'
import { fileReadProvision, metadataProvision } from './provision.ts'
import { GSHEETS_RM } from './rm.ts'

export const GSHEETS_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<GSheetsAccessor>(ResourceName.GSHEETS, GSHEETS_CMD_OPS, {
    provisionOverrides: {
      grep: fileReadProvision as ProvisionFn,
      rg: fileReadProvision as ProvisionFn,
      ls: metadataProvision as ProvisionFn,
      find: metadataProvision as ProvisionFn,
    },
  }),
  ...GSHEETS_RM,
  ...GSHEETS_GWS_CREATE,
  ...GSHEETS_GWS_BATCH_UPDATE,
  ...GSHEETS_GWS_READ,
  ...GSHEETS_GWS_WRITE,
  ...GSHEETS_GWS_APPEND,
]
