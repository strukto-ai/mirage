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
import { GSHEETS_IO } from './io.ts'
import { fileReadProvision } from './provision.ts'
import { GSHEETS_RM } from './rm.ts'

// Sheets verbs and API passthroughs live in the gws CLI
// (commands/cli/builtin/gws), installed by name; the mount only serves
// the filesystem surface.
export const GSHEETS_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<GSheetsAccessor>(ResourceName.GSHEETS, GSHEETS_IO, {
    provisionOverrides: {
      grep: fileReadProvision as ProvisionFn,
      rg: fileReadProvision as ProvisionFn,
    },
  }),
  ...GSHEETS_RM,
]
