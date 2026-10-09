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

import { AirtableConfigSchema } from '../../../../core/airtable/config.ts'
import { Argument } from '../../../spec/types.ts'

import * as reads from './reads.ts'
import * as writes from './writes.ts'

const BASE_OPTION = new Argument('--base', { required: true, help: 'Base ID (app...)' })

const TABLE_OPTION = new Argument('--table', { required: true, help: 'Table ID or name' })

const FIELDS_OPTION = new Argument('--fields', {
  help: 'Cell values as a JSON object keyed by field name',
})

const TYPECAST_OPTION = new Argument('--typecast', {
  action: 'store_true',
  help: 'Let Airtable convert string values to the field types',
})

const RECORD = new Argument('RECORD', { nargs: '?' })

const CREATE_EPILOG =
  'Without --fields, reads records.jsonl lines from stdin and creates one\n' +
  'record per line from its "fields"; computed fields are dropped.'

const UPDATE_EPILOG =
  'Without RECORD --fields, reads records.jsonl lines from stdin and patches\n' +
  'each "record_id" with its "fields"; computed fields are dropped.'

const DELETE_EPILOG =
  'Without RECORD operands, reads records.jsonl lines from stdin and deletes\n' +
  'each "record_id".'

// The airtable program tree. Bases, tables and records are addressed by the
// ids the mount prints after the last "__" of a directory name; a write takes
// one record from flags or many as JSONL on stdin, the shape records.jsonl
// holds. Install with an AirtableConfig.
export const AIRTABLE = new CLI({
  spec: new CommandSpec({
    name: 'airtable',
    description: 'Airtable Web API client',
    subcommands: [
      new CommandSpec({
        name: 'base',
        description: 'Read bases',
        subcommands: [
          new CommandSpec({
            name: 'list',
            description: 'List the bases the token reaches as JSON',
          }),
          new CommandSpec({
            name: 'get',
            description: 'Get one base and its tables (base.json)',
            arguments: [new Argument('BASE', { nargs: '?' })],
          }),
        ],
      }),
      new CommandSpec({
        name: 'table',
        description: 'Read table schemas',
        subcommands: [
          new CommandSpec({
            name: 'get',
            description: "Get one table's fields and views (table.json)",
            arguments: [BASE_OPTION, new Argument('TABLE', { nargs: '?' })],
          }),
        ],
      }),
      new CommandSpec({
        name: 'record',
        description: 'Read and write records',
        subcommands: [
          new CommandSpec({
            name: 'list',
            description: 'List records as JSONL (records.jsonl)',
            arguments: [
              BASE_OPTION,
              TABLE_OPTION,
              new Argument('--view', { help: 'View ID or name; its filter and sort apply' }),
              new Argument('--formula', {
                help: 'Only the records this formula is true for (filterByFormula)',
              }),
              new Argument('--max-records', { type: 'int', help: 'Stop after N records' }),
            ],
          }),
          new CommandSpec({
            name: 'get',
            description: 'Get one record as a JSONL line',
            arguments: [BASE_OPTION, TABLE_OPTION, RECORD],
          }),
          new CommandSpec({
            name: 'create',
            description: 'Create records from --fields or stdin',
            arguments: [BASE_OPTION, TABLE_OPTION, FIELDS_OPTION, TYPECAST_OPTION],
            epilog: CREATE_EPILOG,
          }),
          new CommandSpec({
            name: 'update',
            description: "Update records' cells (PATCH) from RECORD --fields or stdin",
            arguments: [BASE_OPTION, TABLE_OPTION, FIELDS_OPTION, TYPECAST_OPTION, RECORD],
            epilog: UPDATE_EPILOG,
          }),
          new CommandSpec({
            name: 'delete',
            description: 'Delete records by RECORD or from stdin',
            arguments: [BASE_OPTION, TABLE_OPTION, new Argument('RECORD', { nargs: '*' })],
            epilog: DELETE_EPILOG,
          }),
        ],
      }),
      new CommandSpec({
        name: 'comment',
        description: 'Read and add record comments',
        subcommands: [
          new CommandSpec({
            name: 'list',
            description: "List a record's comments, newest first",
            arguments: [BASE_OPTION, TABLE_OPTION, RECORD],
          }),
          new CommandSpec({
            name: 'add',
            description: 'Comment on a record',
            arguments: [
              BASE_OPTION,
              TABLE_OPTION,
              new Argument('--text', { help: 'Comment text (or pipe via stdin)' }),
              RECORD,
            ],
          }),
        ],
      }),
    ],
  }),
  handlers: {
    'base list': new CLIHandler({ fn: reads.baseList }),
    'base get': new CLIHandler({ fn: reads.baseGet }),
    'table get': new CLIHandler({ fn: reads.tableGet }),
    'record list': new CLIHandler({ fn: reads.recordList }),
    'record get': new CLIHandler({ fn: reads.recordGet }),
    'record create': new CLIHandler({ fn: writes.recordCreate, write: true }),
    'record update': new CLIHandler({ fn: writes.recordUpdate, write: true }),
    'record delete': new CLIHandler({ fn: writes.recordDelete, write: true }),
    'comment list': new CLIHandler({ fn: reads.commentList }),
    'comment add': new CLIHandler({ fn: writes.commentAdd, write: true }),
  },
  configModel: AirtableConfigSchema,
})
