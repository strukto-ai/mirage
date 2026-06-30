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

import type { GDocsAccessor } from '../../../accessor/gdocs.ts'
import { ResourceName } from '../../../types.ts'
import type { ProvisionFn, RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { GDOCS_GWS_BATCH_UPDATE } from './gws_docs_documents_batchUpdate.ts'
import { GDOCS_GWS_CREATE } from './gws_docs_documents_create.ts'
import { GDOCS_GWS_WRITE } from './gws_docs_write.ts'
import { GDOCS_CMD_OPS } from './ops.ts'
import { fileReadProvision, metadataProvision } from './provision.ts'
import { GDOCS_RM } from './rm.ts'

export const GDOCS_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<GDocsAccessor>(ResourceName.GDOCS, GDOCS_CMD_OPS, {
    provisionOverrides: {
      grep: fileReadProvision as ProvisionFn,
      rg: fileReadProvision as ProvisionFn,
      ls: metadataProvision as ProvisionFn,
      find: metadataProvision as ProvisionFn,
    },
  }),
  ...GDOCS_RM,
  ...GDOCS_GWS_BATCH_UPDATE,
  ...GDOCS_GWS_CREATE,
  ...GDOCS_GWS_WRITE,
]
