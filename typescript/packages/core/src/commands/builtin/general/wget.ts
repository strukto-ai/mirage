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

import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { HttpConnectError, httpGet, isHttpError } from '../utils/http.ts'
import { UsageError } from '../../errors.ts'
import { resolveTarget } from './curl.ts'
import { FlagView } from '../../spec/types.ts'

const ENC = new TextEncoder()

// Exit codes GNU wget uses for the failures mirage can hit. Unlike curl, wget
// treats any 4xx/5xx as a failure (EXIT_SERVER_ERROR) and needs no flag to do
// so, and it reports a local write failure as a generic EXIT_GENERIC.
const EXIT_GENERIC = 1
const EXIT_NETWORK = 4
const EXIT_SERVER_ERROR = 8

const USAGE =
  "wget: missing URL\nUsage: wget [OPTION]... [URL]...\n\nTry `wget --help' for more options."

async function wgetCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const url = texts[0]
  if (url === undefined) {
    throw new UsageError(USAGE, EXIT_GENERIC)
  }
  const fl = new FlagView(opts.flags, specOf('wget'))
  // -O is short-only, so it lands on the disambiguated `args_O` dest
  // (`AMBIGUOUS_NAMES`); a plain `O` key is one the parser never emits.
  const argsO = fl.asStr('args_O') ?? null
  const q = fl.asBool('q')
  const spider = fl.asBool('spider')

  // wget follows redirects unconditionally; it has no -L equivalent.
  let resp
  try {
    resp = await httpGet(url)
  } catch (err) {
    if (!(err instanceof HttpConnectError)) throw err
    const line = `Connecting to ${err.host}:${String(err.port)}... failed: Connection refused.\n`
    return [
      null,
      new IOResult({
        exitCode: EXIT_NETWORK,
        stderr: q ? new Uint8Array() : ENC.encode(line),
      }),
    ]
  }
  // --spider reports its verdict on stderr, not stdout, and inherits the same
  // exit 8 an error status gives a real download.
  if (spider) {
    if (isHttpError(resp)) {
      return [
        null,
        new IOResult({
          exitCode: EXIT_SERVER_ERROR,
          stderr: q
            ? new Uint8Array()
            : ENC.encode('Remote file does not exist -- broken link!!!\n'),
        }),
      ]
    }
    return [
      null,
      new IOResult({ stderr: q ? new Uint8Array() : ENC.encode('Remote file exists.\n') }),
    ]
  }
  const dest = argsO ?? paths[0]?.virtual ?? url.slice(url.lastIndexOf('/') + 1)
  // An error status still creates the destination, empty, the way GNU wget
  // truncates the -O target before it learns the response code.
  const data = isHttpError(resp) ? new Uint8Array() : resp.body
  if (opts.dispatch !== undefined) {
    const scope = resolveTarget(dest, opts.cwd)
    try {
      await opts.dispatch('write', scope, [data])
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return [
        null,
        new IOResult({
          exitCode: EXIT_GENERIC,
          stderr: q ? new Uint8Array() : ENC.encode(`${dest}: ${errMsg}\n`),
        }),
      ]
    }
  }
  if (isHttpError(resp)) {
    const line = `ERROR ${String(resp.status)}: ${resp.reason}.\n`
    return [
      null,
      new IOResult({
        exitCode: EXIT_SERVER_ERROR,
        stderr: q ? new Uint8Array() : ENC.encode(line),
        writes: { [dest]: data },
      }),
    ]
  }
  // Real wget puts its progress report on stderr and nothing on stdout.
  const line = `'${dest}' saved [${String(data.byteLength)}/${String(data.byteLength)}]\n`
  return [
    null,
    new IOResult({
      stderr: q ? new Uint8Array() : ENC.encode(line),
      writes: { [dest]: data },
    }),
  ]
}

export const GENERAL_WGET = command({
  name: 'wget',
  resource: null,
  spec: specOf('wget'),
  fn: wgetCommand,
})
