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

import { CommandSpec, Operand, OperandKind, Option } from '../types.ts'

export const SPECS: Record<string, CommandSpec> = {
  curl: new CommandSpec({
    description: 'Transfer data from or to a server.',
    options: [
      new Option({
        short: '-H',
        valueKind: OperandKind.TEXT,
        description: 'Add a custom header to the request.',
      }),
      new Option({
        short: '-A',
        valueKind: OperandKind.TEXT,
        description: 'Set the User-Agent header.',
      }),
      new Option({
        short: '-X',
        valueKind: OperandKind.TEXT,
        description: 'Specify the HTTP request method.',
      }),
      new Option({
        short: '-d',
        valueKind: OperandKind.TEXT,
        description: 'Send the given data as the request body.',
      }),
      new Option({
        short: '-F',
        valueKind: OperandKind.TEXT,
        description: 'Submit a multipart/form-data field.',
      }),
      new Option({
        short: '-o',
        valueKind: OperandKind.PATH,
        description: 'Write response body to the given file.',
      }),
      new Option({ short: '-L', description: 'Follow HTTP redirects.' }),
      new Option({
        short: '-f',
        long: '--fail',
        description: 'Fail with exit 22 on an HTTP error status.',
      }),
      new Option({ short: '-s', description: 'Run silently with no progress or messages.' }),
      new Option({ short: '-S', description: 'Show errors even when silent.' }),
    ],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  wget: new CommandSpec({
    description: 'Retrieve files from the web.',
    options: [
      new Option({
        short: '-O',
        valueKind: OperandKind.PATH,
        description: 'Write the downloaded content to the given file.',
      }),
      new Option({ short: '-q', description: 'Run quietly with no output.' }),
      new Option({
        long: '--spider',
        description: 'Check that the URL exists without downloading it.',
      }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
}
