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

import { CommandSpec, Operand, Option } from '../types.ts'

export const SPECS: Record<string, CommandSpec> = {
  curl: new CommandSpec({
    description: 'Transfer data from or to a server.',
    options: [
      new Option({
        short: '-H',
        type: 'str',
        description: 'Add a custom header to the request.' }),
      new Option({
        short: '-A',
        type: 'str',
        description: 'Set the User-Agent header.' }),
      new Option({
        short: '-X',
        type: 'str',
        description: 'Specify the HTTP request method.' }),
      new Option({
        short: '-d',
        type: 'str',
        description: 'Send the given data as the request body.' }),
      new Option({
        short: '-F',
        type: 'str',
        description: 'Submit a multipart/form-data field.' }),
      new Option({
        short: '-o',
        type: 'path',
        description: 'Write response body to the given file.' }),
      new Option({ short: '-L', description: 'Follow HTTP redirects.' }),
      new Option({
        short: '-f',
        long: '--fail',
        description: 'Fail with exit 22 on an HTTP error status.' }),
      new Option({ short: '-s', description: 'Run silently with no progress or messages.' }),
      new Option({ short: '-S', description: 'Show errors even when silent.' }),
    ],
    rest: new Operand({ type: 'str' }) }),
  wget: new CommandSpec({
    description: 'Retrieve files from the web.',
    options: [
      new Option({
        short: '-O',
        type: 'path',
        description: 'Write the downloaded content to the given file.' }),
      new Option({ short: '-q', description: 'Run quietly with no output.' }),
      new Option({
        long: '--spider',
        description: 'Check that the URL exists without downloading it.' }),
    ],
    positional: [new Operand({ type: 'str' })],
    rest: new Operand({ type: 'path' }) }) }
