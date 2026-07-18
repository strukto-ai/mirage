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

import type { LinearAccessor } from '../../../accessor/linear.ts'
import { ResourceName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { LINEAR_ISSUE_ADD_LABEL } from './linear_issue_add_label.ts'
import { LINEAR_ISSUE_ASSIGN } from './linear_issue_assign.ts'
import { LINEAR_ISSUE_COMMENT_ADD } from './linear_issue_comment_add.ts'
import { LINEAR_ISSUE_COMMENT_UPDATE } from './linear_issue_comment_update.ts'
import { LINEAR_ISSUE_CREATE } from './linear_issue_create.ts'
import { LINEAR_ISSUE_SET_PRIORITY } from './linear_issue_set_priority.ts'
import { LINEAR_ISSUE_SET_PROJECT } from './linear_issue_set_project.ts'
import { LINEAR_ISSUE_TRANSITION } from './linear_issue_transition.ts'
import { LINEAR_ISSUE_UPDATE } from './linear_issue_update.ts'
import { LINEAR_SEARCH } from './linear_search.ts'
import { LINEAR_IO } from './io.ts'

const LINEAR_OVERRIDES = new Set<string>()

export const LINEAR_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<LinearAccessor>(ResourceName.LINEAR, LINEAR_IO, {
    overrides: LINEAR_OVERRIDES,
  }),
  ...LINEAR_ISSUE_ADD_LABEL,
  ...LINEAR_ISSUE_ASSIGN,
  ...LINEAR_ISSUE_COMMENT_ADD,
  ...LINEAR_ISSUE_COMMENT_UPDATE,
  ...LINEAR_ISSUE_CREATE,
  ...LINEAR_ISSUE_SET_PRIORITY,
  ...LINEAR_ISSUE_SET_PROJECT,
  ...LINEAR_ISSUE_TRANSITION,
  ...LINEAR_ISSUE_UPDATE,
  ...LINEAR_SEARCH,
]
