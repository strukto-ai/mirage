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
import { httpGet } from '../utils/http.ts'
import { resolveTarget } from './curl.ts'

const ENC = new TextEncoder()

async function wgetCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const url = texts[0]
  if (url === undefined) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('wget: missing URL\n') })]
  }
  const argsO =
    typeof opts.flags.args_O === 'string'
      ? opts.flags.args_O
      : typeof opts.flags.O === 'string'
        ? opts.flags.O
        : null
  const q = opts.flags.q === true
  const spider = opts.flags.spider === true

  let data: Uint8Array
  try {
    data = await httpGet(url)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`wget: ${msg}\n`) })]
  }
  if (spider) {
    const output = q ? '' : `Spider mode: ${url} exists (${String(data.byteLength)} bytes)`
    return [ENC.encode(output), new IOResult()]
  }
  const dest = argsO ?? paths[0]?.virtual ?? url.slice(url.lastIndexOf('/') + 1)
  if (opts.dispatch !== undefined) {
    const scope = resolveTarget(dest, opts.cwd)
    try {
      await opts.dispatch('write', scope, [data])
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`wget: ${dest}: ${errMsg}\n`) })]
    }
  }
  const output = q ? '' : `saved ${String(data.byteLength)} bytes to ${dest}`
  return [ENC.encode(output), new IOResult({ writes: { [dest]: data } })]
}

export const GENERAL_WGET = command({
  name: 'wget',
  resource: null,
  spec: specOf('wget'),
  fn: wgetCommand,
})
