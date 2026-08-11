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

import { LinearConfigSchema } from '../../../../core/linear/config.ts'
import { registerCliSpec } from '../../specs.ts'
import { CLISpec } from '../../types.ts'
import { Operand, Option } from '../../../spec/types.ts'
import { add as commentAdd } from './comment/add.ts'
import { update as commentUpdate } from './comment/update.ts'
import { addLabel } from './issue/add_label.ts'
import { assign } from './issue/assign.ts'
import { create } from './issue/create.ts'
import { setPriority } from './issue/set_priority.ts'
import { setProject } from './issue/set_project.ts'
import { transition } from './issue/transition.ts'
import { update } from './issue/update.ts'
import * as reads from './reads.ts'

const TEAM_OPTION = new Option({
  long: '--team',
  type: 'str',
  required: true,
  description: 'Team key, name, or ID',
})

const ARG = new Operand({ type: 'str' })

// The linear program tree, keeping the noun/verb grammar the mount
// commands already spoke (`linear issue create`, `linear team list`).
// Issues are addressed by positional key or ID (`linear issue get
// ENG-42`); free text (descriptions, comment bodies) comes from a flag
// or stdin. Install with a LinearConfig.
export const LINEAR = new CLISpec({
  name: 'linear',
  description: 'Linear GraphQL API client',
  configModel: LinearConfigSchema,
  subcommands: [
    new CLISpec({
      name: 'team',
      description: 'Manage teams',
      subcommands: [
        new CLISpec({ name: 'list', description: 'List teams as JSON', fn: reads.teamList }),
        new CLISpec({
          name: 'get',
          description: 'Get one team by key, name, or ID',
          fn: reads.teamGet,
          rest: ARG,
        }),
        new CLISpec({
          name: 'members',
          description: "List a team's members",
          fn: reads.teamMembers,
          rest: ARG,
        }),
      ],
    }),
    new CLISpec({
      name: 'issue',
      description: 'Manage issues',
      subcommands: [
        new CLISpec({
          name: 'list',
          description: "List a team's issues",
          fn: reads.issueList,
          options: [TEAM_OPTION],
        }),
        new CLISpec({
          name: 'get',
          description: 'Get one issue by key or ID',
          fn: reads.issueGet,
          rest: ARG,
        }),
        new CLISpec({
          name: 'create',
          description: 'Create an issue',
          fn: create,
          write: true,
          options: [
            TEAM_OPTION,
            new Option({ long: '--title', type: 'str', required: true }),
            new Option({
              long: '--description',
              type: 'str',
              description: 'Body text (or pipe via stdin)',
            }),
          ],
        }),
        new CLISpec({
          name: 'update',
          description: "Update an issue's title or description",
          fn: update,
          write: true,
          rest: ARG,
          options: [
            new Option({ long: '--title', type: 'str' }),
            new Option({
              long: '--description',
              type: 'str',
              description: 'Body text (or pipe via stdin)',
            }),
          ],
        }),
        new CLISpec({
          name: 'assign',
          description: 'Assign an issue to a user',
          fn: assign,
          write: true,
          rest: ARG,
          options: [
            new Option({ long: '--assignee-id', type: 'str' }),
            new Option({ long: '--assignee-email', type: 'str' }),
          ],
        }),
        new CLISpec({
          name: 'transition',
          description: 'Move an issue to a workflow state',
          fn: transition,
          write: true,
          rest: ARG,
          options: [
            new Option({ long: '--state-id', type: 'str' }),
            new Option({ long: '--state-name', type: 'str' }),
          ],
        }),
        new CLISpec({
          name: 'set-priority',
          description: "Set an issue's priority",
          fn: setPriority,
          write: true,
          rest: ARG,
          options: [
            new Option({
              long: '--priority',
              type: 'int',
              required: true,
              description: '0=none, 1=urgent, 2=high, 3=medium, 4=low',
            }),
          ],
        }),
        new CLISpec({
          name: 'set-project',
          description: 'Attach an issue to a project',
          fn: setProject,
          write: true,
          rest: ARG,
          options: [
            new Option({ long: '--project', type: 'str', description: 'Project ID' }),
            new Option({
              long: '--project-name',
              type: 'str',
              description: "Project name, looked up on the issue's team",
            }),
          ],
        }),
        new CLISpec({
          name: 'add-label',
          description: 'Add a label to an issue',
          fn: addLabel,
          write: true,
          rest: ARG,
          options: [
            new Option({ long: '--label', type: 'str', description: 'Label ID' }),
            new Option({
              long: '--label-name',
              type: 'str',
              description: "Label name, looked up on the issue's team",
            }),
          ],
        }),
      ],
    }),
    new CLISpec({
      name: 'project',
      description: 'Manage projects',
      subcommands: [
        new CLISpec({
          name: 'list',
          description: "List a team's projects",
          fn: reads.projectList,
          options: [TEAM_OPTION],
        }),
        new CLISpec({
          name: 'get',
          description: 'Get one project by ID',
          fn: reads.projectGet,
          rest: ARG,
          options: [TEAM_OPTION],
        }),
      ],
    }),
    new CLISpec({
      name: 'cycle',
      description: 'Manage cycles',
      subcommands: [
        new CLISpec({
          name: 'list',
          description: "List a team's cycles",
          fn: reads.cycleList,
          options: [TEAM_OPTION],
        }),
        new CLISpec({
          name: 'current',
          description: "Get a team's current cycle",
          fn: reads.cycleCurrent,
          options: [TEAM_OPTION],
        }),
        new CLISpec({
          name: 'get',
          description: 'Get one cycle by ID',
          fn: reads.cycleGet,
          rest: ARG,
          options: [TEAM_OPTION],
        }),
      ],
    }),
    new CLISpec({
      name: 'label',
      description: 'Manage labels',
      subcommands: [
        new CLISpec({
          name: 'list',
          description: "List a team's labels",
          fn: reads.labelList,
          options: [TEAM_OPTION],
        }),
      ],
    }),
    new CLISpec({
      name: 'comment',
      description: 'Manage comments',
      subcommands: [
        new CLISpec({
          name: 'list',
          description: "List an issue's comments",
          fn: reads.commentList,
          rest: ARG,
        }),
        new CLISpec({
          name: 'add',
          description: 'Comment on an issue',
          fn: commentAdd,
          write: true,
          rest: ARG,
          options: [
            new Option({
              long: '--body',
              type: 'str',
              description: 'Comment text (or pipe via stdin)',
            }),
          ],
        }),
        new CLISpec({
          name: 'update',
          description: 'Edit a comment',
          fn: commentUpdate,
          write: true,
          options: [
            new Option({
              long: '--comment',
              type: 'str',
              required: true,
              description: 'Comment ID',
            }),
            new Option({
              long: '--body',
              type: 'str',
              description: 'Comment text (or pipe via stdin)',
            }),
          ],
        }),
      ],
    }),
    new CLISpec({
      name: 'user',
      description: 'Manage users',
      subcommands: [
        new CLISpec({ name: 'list', description: 'List workspace users', fn: reads.userList }),
        new CLISpec({
          name: 'get',
          description: 'Get one user by email',
          fn: reads.userGet,
          rest: ARG,
        }),
      ],
    }),
    new CLISpec({
      name: 'document',
      description: 'Manage documents',
      subcommands: [
        new CLISpec({
          name: 'list',
          description: "List a team's documents",
          fn: reads.documentList,
          options: [TEAM_OPTION],
        }),
        new CLISpec({
          name: 'get',
          description: 'Get one document by ID',
          fn: reads.documentGet,
          rest: ARG,
          options: [TEAM_OPTION],
        }),
      ],
    }),
    new CLISpec({
      name: 'search',
      description: 'Search issues by text',
      fn: reads.search,
      rest: ARG,
      options: [new Option({ long: '--query', type: 'str' })],
    }),
  ],
})

registerCliSpec(LINEAR)
