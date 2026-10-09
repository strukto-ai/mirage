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
import { CommandSpec } from '../../../spec/types.ts'
import { CLI } from '../../types.ts'
import { CLIHandler } from '../../types.ts'

import { LinearConfigSchema } from '../../../../core/linear/config.ts'

import { Argument } from '../../../spec/types.ts'
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

const TEAM_OPTION = new Argument('--team', { required: true, help: 'Team key, name, or ID' })

const ARG = new Argument('text', { metavar: '', nargs: '*' })

// The linear program tree, keeping the noun/verb grammar the mount
// commands already spoke (`linear issue create`, `linear team list`).
// Issues are addressed by positional key or ID (`linear issue get
// ENG-42`); free text (descriptions, comment bodies) comes from a flag
// or stdin. Install with a LinearConfig.
export const LINEAR = new CLI({
  spec: new CommandSpec({
    name: 'linear',
    description: 'Linear GraphQL API client',
    subcommands: [
      new CommandSpec({
        name: 'team',
        description: 'Manage teams',
        subcommands: [
          new CommandSpec({ name: 'list', description: 'List teams as JSON' }),
          new CommandSpec({
            name: 'get',
            description: 'Get one team by key, name, or ID',
            arguments: [ARG],
          }),
          new CommandSpec({
            name: 'members',
            description: "List a team's members",
            arguments: [ARG],
          }),
        ],
      }),
      new CommandSpec({
        name: 'issue',
        description: 'Manage issues',
        subcommands: [
          new CommandSpec({
            name: 'list',
            description: "List a team's issues",
            arguments: [TEAM_OPTION],
          }),
          new CommandSpec({
            name: 'get',
            description: 'Get one issue by key or ID',
            arguments: [ARG],
          }),
          new CommandSpec({
            name: 'create',
            description: 'Create an issue',
            arguments: [
              TEAM_OPTION,
              new Argument('--title', { required: true }),
              new Argument('--description', { help: 'Body text (or pipe via stdin)' }),
            ],
          }),
          new CommandSpec({
            name: 'update',
            description: "Update an issue's title or description",
            arguments: [
              new Argument('--title'),
              new Argument('--description', { help: 'Body text (or pipe via stdin)' }),
              ARG,
            ],
          }),
          new CommandSpec({
            name: 'assign',
            description: 'Assign an issue to a user',
            arguments: [new Argument('--assignee-id'), new Argument('--assignee-email'), ARG],
          }),
          new CommandSpec({
            name: 'transition',
            description: 'Move an issue to a workflow state',
            arguments: [new Argument('--state-id'), new Argument('--state-name'), ARG],
          }),
          new CommandSpec({
            name: 'set-priority',
            description: "Set an issue's priority",
            arguments: [
              new Argument('--priority', {
                type: 'int',
                required: true,
                help: '0=none, 1=urgent, 2=high, 3=medium, 4=low',
              }),
              ARG,
            ],
          }),
          new CommandSpec({
            name: 'set-project',
            description: 'Attach an issue to a project',
            arguments: [
              new Argument('--project', { help: 'Project ID' }),
              new Argument('--project-name', {
                help: "Project name, looked up on the issue's team",
              }),
              ARG,
            ],
          }),
          new CommandSpec({
            name: 'add-label',
            description: 'Add a label to an issue',
            arguments: [
              new Argument('--label', { help: 'Label ID' }),
              new Argument('--label-name', { help: "Label name, looked up on the issue's team" }),
              ARG,
            ],
          }),
        ],
      }),
      new CommandSpec({
        name: 'project',
        description: 'Manage projects',
        subcommands: [
          new CommandSpec({
            name: 'list',
            description: "List a team's projects",
            arguments: [TEAM_OPTION],
          }),
          new CommandSpec({
            name: 'get',
            description: 'Get one project by ID',
            arguments: [TEAM_OPTION, ARG],
          }),
        ],
      }),
      new CommandSpec({
        name: 'cycle',
        description: 'Manage cycles',
        subcommands: [
          new CommandSpec({
            name: 'list',
            description: "List a team's cycles",
            arguments: [TEAM_OPTION],
          }),
          new CommandSpec({
            name: 'current',
            description: "Get a team's current cycle",
            arguments: [TEAM_OPTION],
          }),
          new CommandSpec({
            name: 'get',
            description: 'Get one cycle by ID',
            arguments: [TEAM_OPTION, ARG],
          }),
        ],
      }),
      new CommandSpec({
        name: 'label',
        description: 'Manage labels',
        subcommands: [
          new CommandSpec({
            name: 'list',
            description: "List a team's labels",
            arguments: [TEAM_OPTION],
          }),
        ],
      }),
      new CommandSpec({
        name: 'comment',
        description: 'Manage comments',
        subcommands: [
          new CommandSpec({
            name: 'list',
            description: "List an issue's comments",
            arguments: [ARG],
          }),
          new CommandSpec({
            name: 'add',
            description: 'Comment on an issue',
            arguments: [new Argument('--body', { help: 'Comment text (or pipe via stdin)' }), ARG],
          }),
          new CommandSpec({
            name: 'update',
            description: 'Edit a comment',
            arguments: [
              new Argument('--comment', { required: true, help: 'Comment ID' }),
              new Argument('--body', { help: 'Comment text (or pipe via stdin)' }),
            ],
          }),
        ],
      }),
      new CommandSpec({
        name: 'user',
        description: 'Manage users',
        subcommands: [
          new CommandSpec({ name: 'list', description: 'List workspace users' }),
          new CommandSpec({ name: 'get', description: 'Get one user by email', arguments: [ARG] }),
        ],
      }),
      new CommandSpec({
        name: 'document',
        description: 'Manage documents',
        subcommands: [
          new CommandSpec({
            name: 'list',
            description: "List a team's documents",
            arguments: [TEAM_OPTION],
          }),
          new CommandSpec({
            name: 'get',
            description: 'Get one document by ID',
            arguments: [TEAM_OPTION, ARG],
          }),
        ],
      }),
      new CommandSpec({
        name: 'search',
        description: 'Search issues by text',
        arguments: [new Argument('--query'), ARG],
      }),
    ],
  }),
  handlers: {
    'team list': new CLIHandler({ fn: reads.teamList }),
    'team get': new CLIHandler({ fn: reads.teamGet }),
    'team members': new CLIHandler({ fn: reads.teamMembers }),
    'issue list': new CLIHandler({ fn: reads.issueList }),
    'issue get': new CLIHandler({ fn: reads.issueGet }),
    'issue create': new CLIHandler({ fn: create, write: true }),
    'issue update': new CLIHandler({ fn: update, write: true }),
    'issue assign': new CLIHandler({ fn: assign, write: true }),
    'issue transition': new CLIHandler({ fn: transition, write: true }),
    'issue set-priority': new CLIHandler({ fn: setPriority, write: true }),
    'issue set-project': new CLIHandler({ fn: setProject, write: true }),
    'issue add-label': new CLIHandler({ fn: addLabel, write: true }),
    'project list': new CLIHandler({ fn: reads.projectList }),
    'project get': new CLIHandler({ fn: reads.projectGet }),
    'cycle list': new CLIHandler({ fn: reads.cycleList }),
    'cycle current': new CLIHandler({ fn: reads.cycleCurrent }),
    'cycle get': new CLIHandler({ fn: reads.cycleGet }),
    'label list': new CLIHandler({ fn: reads.labelList }),
    'comment list': new CLIHandler({ fn: reads.commentList }),
    'comment add': new CLIHandler({ fn: commentAdd, write: true }),
    'comment update': new CLIHandler({ fn: commentUpdate, write: true }),
    'user list': new CLIHandler({ fn: reads.userList }),
    'user get': new CLIHandler({ fn: reads.userGet }),
    'document list': new CLIHandler({ fn: reads.documentList }),
    'document get': new CLIHandler({ fn: reads.documentGet }),
    search: new CLIHandler({ fn: reads.search }),
  },
  configModel: LinearConfigSchema,
})
