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

import type { GitHubCIAccessor } from '../../../accessor/github_ci.ts'
import { ResourceName } from '../../../types.ts'
import type { ProvisionFn, RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { GITHUB_CI_FIND } from './find.ts'
import { GITHUB_CI_GREP } from './grep.ts'
import { GITHUB_CI_CMD_OPS } from './ops.ts'
import { metadataProvision } from './provision.ts'
import { GITHUB_CI_RG } from './rg.ts'

const GITHUB_CI_OVERRIDES = new Set(['find', 'grep', 'rg'])

export const GITHUB_CI_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<GitHubCIAccessor>(ResourceName.GITHUB_CI, GITHUB_CI_CMD_OPS, {
    overrides: GITHUB_CI_OVERRIDES,
    provisionOverrides: {
      ls: metadataProvision as ProvisionFn,
    },
  }),
  ...GITHUB_CI_FIND,
  ...GITHUB_CI_GREP,
  ...GITHUB_CI_RG,
]
