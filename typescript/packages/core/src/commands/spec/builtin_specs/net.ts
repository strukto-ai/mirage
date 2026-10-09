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
import { CommandSpec, Argument } from '../types.ts'

export const SPECS: Record<string, CommandSpec> = {
  curl: new CommandSpec({
    description: 'Transfer data from or to a server.',
    arguments: [
      new Argument(['-H', '--header'], {
        action: 'append',
        help: 'Add a custom header to the request.',
      }),
      new Argument(['-A', '--user-agent'], { help: 'Set the User-Agent header.' }),
      new Argument(['-X', '--request'], { help: 'Specify the HTTP request method.' }),
      new Argument(['-d', '--data'], {
        action: 'append',
        help: 'Send the given data as the request body.',
      }),
      new Argument('--data-binary', {
        action: 'append',
        help: 'Send the data exactly as given, a file unchanged.',
      }),
      new Argument('--data-raw', {
        action: 'append',
        help: 'Send the data with no special meaning for @.',
      }),
      new Argument('--data-urlencode', { action: 'append', help: 'Send the data URL-encoded.' }),
      new Argument('--json', { action: 'append', help: 'Send the data as JSON.' }),
      new Argument(['-u', '--user'], { help: 'Send the user and password for basic auth.' }),
      new Argument(['-F', '--form'], { help: 'Submit a multipart/form-data field.' }),
      new Argument(['-o', '--output'], {
        type: 'path',
        help: 'Write response body to the given file.',
      }),
      new Argument(['-D', '--dump-header'], {
        type: 'path',
        help: 'Write the received headers to the given file, - for stdout.',
      }),
      new Argument(['-L', '--location'], { action: 'store_true', help: 'Follow HTTP redirects.' }),
      new Argument(['-f', '--fail'], {
        action: 'store_true',
        help: 'Fail with exit 22 on an HTTP error status.',
      }),
      new Argument(['-s', '--silent'], {
        action: 'store_true',
        help: 'Run silently with no progress or messages.',
      }),
      new Argument(['-S', '--show-error'], {
        action: 'store_true',
        help: 'Show errors even when silent.',
      }),
      new Argument(['-v', '--verbose'], {
        action: 'store_true',
        help: 'Dump the request and response headers on stderr.',
      }),
      new Argument(['-i', '--include'], {
        action: 'store_true',
        help: 'Include the response headers in the output.',
      }),
      new Argument(['-I', '--head'], { action: 'store_true', help: 'Fetch the headers only.' }),
      new Argument(['-4', '--ipv4'], {
        action: 'store_true',
        help: 'Accept IPv4 preference (transport selects the address family).',
      }),
      new Argument(['-6', '--ipv6'], {
        action: 'store_true',
        help: 'Accept IPv6 preference (transport selects the address family).',
      }),
      new Argument(['-w', '--write-out'], { help: 'Print transfer information after completion.' }),
      new Argument(['-m', '--max-time'], {
        type: 'float',
        help: 'Give up after this many seconds.',
      }),
      new Argument(['-k', '--insecure'], {
        action: 'store_true',
        help: 'Skip verification of the server certificate.',
      }),
      new Argument('text', { metavar: '', nargs: '?' }),
    ],
  }),
  wget: new CommandSpec({
    description: 'Retrieve files from the web.',
    arguments: [
      new Argument('-O', { type: 'path', help: 'Write the downloaded content to the given file.' }),
      new Argument('-q', { action: 'store_true', help: 'Run quietly with no output.' }),
      new Argument(['-T', '--timeout'], {
        type: 'float',
        help: 'Set the network timeout in seconds (zero disables it).',
      }),
      new Argument('--spider', {
        action: 'store_true',
        help: 'Check that the URL exists without downloading it.',
      }),
      new Argument('text', { metavar: '', nargs: '?' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
}
