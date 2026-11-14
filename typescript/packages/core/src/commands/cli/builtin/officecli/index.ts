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

import { Argument, CommandSpec } from '../../../spec/types.ts'
import { CLI, CLIHandler } from '../../types.ts'
import { runCommand } from './run.ts'

// Descriptions and argument help as OfficeCLI 1.0.161 (iOfficeAI,
// Apache-2.0) prints them; mirage serves its .xlsx commands and reads
// .docx and .pptx files.
export const FILE = new Argument('FILE', {
  type: 'path',
  metavar: 'file',
  help: 'Office document path (required even with open/close mode)',
})

export const JSON_FLAG = new Argument('--json', {
  action: 'store_true',
  help: 'Output as JSON (AI-friendly)',
})

export const OFFICECLI = new CLI({
  spec: new CommandSpec({
    name: 'officecli',
    description: 'officecli: AI-friendly CLI for Office documents (.docx, .xlsx, .pptx)',
    subcommands: [
      new CommandSpec({
        name: 'create',
        description: 'Create a blank Office document',
        arguments: [
          new Argument('FILE', {
            type: 'path',
            metavar: 'file',
            help: 'Output file path (.docx, .xlsx, .pptx)',
          }),
          new Argument('--force', { action: 'store_true', help: 'Overwrite an existing file.' }),
          JSON_FLAG,
        ],
      }),
      new CommandSpec({
        name: 'get',
        description: 'Get a document node by path',
        arguments: [
          FILE,
          new Argument('PATH', { nargs: '?', metavar: 'path', help: 'DOM path [default: /]' }),
          new Argument('--depth', {
            type: 'int',
            metavar: 'depth',
            help: 'Depth of child nodes to include [default: 1]',
          }),
          JSON_FLAG,
        ],
      }),
      new CommandSpec({
        name: 'query',
        description: 'Query document elements with CSS-like selectors',
        arguments: [
          FILE,
          new Argument('SELECTOR', {
            metavar: 'selector',
            help: "CSS-like selector: element type, [attribute] predicates with = != ~= > < >= <= and and/or, '>' child combinator, ',' union, and a positional [N]",
          }),
          JSON_FLAG,
          new Argument('--find', {
            metavar: 'find',
            help: 'Filter results to elements containing this text (case-insensitive substring)',
          }),
        ],
      }),
      new CommandSpec({
        name: 'set',
        description: "Modify a document node's properties",
        arguments: [
          FILE,
          new Argument('PATH', { metavar: 'path', help: 'DOM path to the element' }),
          new Argument('--prop', {
            action: 'append',
            metavar: 'prop',
            help: 'Property to set (key=value)',
          }),
          JSON_FLAG,
        ],
      }),
      new CommandSpec({
        name: 'remove',
        description: 'Remove an element from the document',
        arguments: [
          FILE,
          new Argument('PATH', { metavar: 'path', help: 'DOM path of the element to remove' }),
          JSON_FLAG,
        ],
      }),
      new CommandSpec({
        name: 'batch',
        description: 'Execute multiple commands from a JSON array in a single pass',
        arguments: [
          new Argument('FILE', { type: 'path', metavar: 'file', help: 'Office document path' }),
          new Argument('--input', {
            type: 'path',
            metavar: 'input',
            help: 'JSON file containing batch commands. If omitted, reads from stdin',
          }),
          new Argument('--commands', {
            metavar: 'commands',
            help: 'Inline JSON array of batch commands (alternative to --input or stdin)',
          }),
          new Argument('--force', {
            action: 'store_true',
            help: 'Deprecated alias for the default continue-on-error mode (kept for compatibility)',
          }),
          new Argument('--stop-on-error', {
            action: 'store_true',
            help: 'Abort the batch as soon as any command fails',
          }),
          new Argument('--best-effort', {
            action: 'store_true',
            help: 'Apply the items that succeed even when others fail. Default: any failure rolls back the whole batch',
          }),
          JSON_FLAG,
        ],
      }),
    ],
  }),
  handlers: {
    create: new CLIHandler({ fn: runCommand, write: true }),
    get: new CLIHandler({ fn: runCommand }),
    query: new CLIHandler({ fn: runCommand }),
    set: new CLIHandler({ fn: runCommand, write: true }),
    remove: new CLIHandler({ fn: runCommand, write: true }),
    batch: new CLIHandler({ fn: runCommand, write: true }),
  },
})
