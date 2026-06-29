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

import type { MongoDBAccessor } from '../../../accessor/mongodb.ts'
import { ResourceName } from '../../../types.ts'
import type { ProvisionFn, RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { metadataProvision } from './_provision.ts'
import { MONGODB_CAT } from './cat.ts'
import { MONGODB_FIND } from './find.ts'
import { MONGODB_GREP } from './grep.ts'
import { MONGODB_CMD_OPS } from './ops.ts'
import { MONGODB_RG } from './rg.ts'
import { MONGODB_TAIL } from './tail.ts'
import { MONGODB_WC } from './wc.ts'

const MONGODB_OVERRIDES = new Set(['cat', 'find', 'grep', 'rg', 'tail', 'wc'])

export const MONGODB_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<MongoDBAccessor>(ResourceName.MONGODB, MONGODB_CMD_OPS, {
    overrides: MONGODB_OVERRIDES,
    provisionOverrides: {
      ls: metadataProvision as ProvisionFn,
    },
  }),
  ...MONGODB_CAT,
  ...MONGODB_FIND,
  ...MONGODB_GREP,
  ...MONGODB_RG,
  ...MONGODB_TAIL,
  ...MONGODB_WC,
]
