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

import {
  type ProvisionFn,
  type RegisteredCommand,
  makeGenericCommands,
} from '@struktoai/mirage-core'
import { HF_RESOURCES, type HfAccessor } from '../../../accessor/hf.ts'
import { HF_DU } from './du.ts'
import { HF_FIND } from './find.ts'
import { HF_CMD_OPS } from './ops.ts'
import { fileReadProvision, metadataProvision } from './provision.ts'
import { HF_RM } from './rm.ts'
import { HF_SED } from './sed.ts'

const HF_OVERRIDES = new Set(['cp', 'mv', 'rm', 'du', 'sed', 'find'])

export const HF_COMMANDS: readonly RegisteredCommand[] = [
  ...HF_RESOURCES.flatMap((resource) =>
    makeGenericCommands<HfAccessor>(resource, HF_CMD_OPS, {
      overrides: HF_OVERRIDES,
      provisionOverrides: {
        grep: fileReadProvision as ProvisionFn,
        rg: fileReadProvision as ProvisionFn,
        ls: metadataProvision as ProvisionFn,
      },
    }),
  ),
  ...HF_DU,
  ...HF_FIND,
  ...HF_RM,
  ...HF_SED,
]
