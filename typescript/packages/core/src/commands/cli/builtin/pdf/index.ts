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

import { Argument, CommandSpec, UsageStyle } from '../../../spec/types.ts'
import { CLI, CLIHandler } from '../../types.ts'
import { runPdfinfo, runPdftotext } from './run.ts'

export const FIRST = new Argument('-f', { metavar: 'int', help: 'First page to read (default: 1)' })
export const LAST = new Argument('-l', {
  metavar: 'int',
  help: 'Last page to read (default: the last)',
})
export const OWNER = new Argument('-opw', {
  metavar: 'string',
  help: 'Owner password of an encrypted file',
})
export const USER = new Argument('-upw', {
  metavar: 'string',
  help: 'User password of an encrypted file',
})
export const QUIET = new Argument('-q', {
  action: 'store_true',
  help: 'Print no messages and no errors',
})
export const HELP = new Argument(['-h', '-help', '--help', '-?'], {
  action: 'store_true',
  help: 'Show this help and exit',
})

export const PDFTOTEXT = new CLI({
  spec: new CommandSpec({
    name: 'pdftotext',
    description:
      "Write the text of a PDF file to a text file, or to standard output when the text file is '-'. Pages end in a form feed.",
    addHelp: false,
    usageStyle: UsageStyle.POPPLER,
    arguments: [
      FIRST,
      LAST,
      new Argument('-layout', {
        action: 'store_true',
        help: "Keep each page's columns and spacing",
      }),
      new Argument('-raw', {
        action: 'store_true',
        help: 'Keep text in the order the page draws it',
      }),
      new Argument('-nodiag', { action: 'store_true', help: 'Leave out text set at a slant' }),
      new Argument('-enc', {
        metavar: 'string',
        help: 'Encoding of the text written; UTF-8 is the one served',
      }),
      new Argument('-eol', { metavar: 'string', help: 'Line ending to write: unix, dos or mac' }),
      new Argument('-nopgbrk', {
        action: 'store_true',
        help: 'Write no form feed after each page',
      }),
      OWNER,
      USER,
      QUIET,
      HELP,
      new Argument('FILE', {
        type: 'path',
        nargs: '*',
        metavar: 'PDF-file [text-file]',
        help: "The PDF file, '-' for standard input; then the text file",
      }),
    ],
  }),
  handlers: { '': new CLIHandler({ fn: runPdftotext, write: true }) },
})

export const PDFINFO = new CLI({
  spec: new CommandSpec({
    name: 'pdfinfo',
    description:
      "Print a PDF file's document information: its metadata, page count, page size and PDF version.",
    addHelp: false,
    usageStyle: UsageStyle.POPPLER,
    arguments: [
      new Argument('-f', { metavar: 'int', help: 'First page whose size to list' }),
      new Argument('-l', { metavar: 'int', help: 'Last page whose size to list' }),
      OWNER,
      USER,
      QUIET,
      HELP,
      new Argument('FILE', {
        type: 'path',
        nargs: '*',
        metavar: 'PDF-file',
        help: "The PDF file, '-' for standard input",
      }),
    ],
  }),
  handlers: { '': new CLIHandler({ fn: runPdfinfo }) },
})
