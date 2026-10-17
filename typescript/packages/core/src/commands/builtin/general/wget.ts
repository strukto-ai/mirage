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
import { PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { HttpConnectError, HttpTimeoutError } from '../errors.ts'
import { HTTP_TIMEOUT_SECONDS } from '../utils/constants.ts'
import { httpGet, isHttpError } from '../utils/http.ts'
import { UsageError } from '../../errors.ts'
import { resolveTarget } from '../utils/paths.ts'
import { said } from './curl.ts'
import { fsStrerror, isWalkError } from '../../../errors/fs.ts'
import { FlagView } from '../../spec/flag_view.ts'

const ENC = new TextEncoder()

// Exit codes GNU wget uses for the failures mirage can hit. Unlike curl, wget
// treats any 4xx/5xx as a failure (EXIT_SERVER_ERROR) and needs no flag to do
// so, and it reports a local write failure as a generic EXIT_GENERIC.
const EXIT_GENERIC = 1
const EXIT_NETWORK = 4
const EXIT_SERVER_ERROR = 8

const USAGE =
  "wget: missing URL\nUsage: wget [OPTION]... [URL]...\n\nTry `wget --help' for more options."

async function wget(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const url = texts[0]
  if (url === undefined) {
    throw new UsageError(USAGE, EXIT_GENERIC)
  }
  const fl = new FlagView(ctx.flags, specOf('wget'))
  // -O is short-only, so it lands on the disambiguated `args_O` dest
  // (`AMBIGUOUS_NAMES`); a plain `O` key is one the parser never emits.
  const argsO = fl.asPath('args_O') ?? fl.asStr('args_O') ?? null
  if ((argsO instanceof PathSpec ? argsO.rawPath : argsO) === '') {
    // wget opens -O before it connects, and perror("") is the bare strerror,
    // -q or not (GNU Wget 1.25.0).
    return [
      null,
      new IOResult({ exitCode: EXIT_GENERIC, stderr: ENC.encode('No such file or directory\n') }),
    ]
  }
  const q = fl.asBool('q')
  const spider = fl.asBool('spider')
  const timeout = fl.asFloat('timeout')
  if (timeout !== undefined && timeout < 0)
    throw new UsageError(`wget: --timeout: Negative time period '${String(timeout)}'`, 2)

  // wget follows redirects unconditionally; it has no -L equivalent.
  let resp
  try {
    resp = await httpGet(url, {
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      timeoutMs:
        timeout === undefined ? HTTP_TIMEOUT_SECONDS * 1000 : timeout === 0 ? null : timeout * 1000,
    })
  } catch (err) {
    if (!(err instanceof HttpConnectError) && !(err instanceof HttpTimeoutError)) throw err
    const reason = err instanceof HttpTimeoutError ? 'Connection timed out' : 'Connection refused'
    const line = `Connecting to ${err.host}:${String(err.port)}... failed: ${reason}.\n`
    return [null, new IOResult({ exitCode: EXIT_NETWORK, stderr: said(q, line) })]
  }
  // --spider reports its verdict on stderr, not stdout, and inherits the same
  // exit 8 an error status gives a real download.
  if (spider) {
    if (isHttpError(resp)) {
      const line = 'Remote file does not exist -- broken link!!!\n'
      return [null, new IOResult({ exitCode: EXIT_SERVER_ERROR, stderr: said(q, line) })]
    }
    return [null, new IOResult({ stderr: said(q, 'Remote file exists.\n') })]
  }
  if (
    argsO === '-' ||
    (argsO instanceof PathSpec && argsO.rawPath === '-') ||
    (isHttpError(resp) && argsO === null)
  ) {
    return [
      isHttpError(resp) ? null : resp.body,
      new IOResult({
        exitCode: isHttpError(resp) ? EXIT_SERVER_ERROR : 0,
        stderr: isHttpError(resp)
          ? said(q, `ERROR ${String(resp.status)}: ${resp.reason}.\n`)
          : new Uint8Array(),
      }),
    ]
  }
  const target = argsO ?? paths[0] ?? (url.slice(url.lastIndexOf('/') + 1) || 'index.html')
  const dest = target instanceof PathSpec ? target.virtual : target
  // An error status still creates the destination, empty, the way GNU wget
  // truncates the -O target before it learns the response code.
  const data = isHttpError(resp) ? new Uint8Array() : resp.body
  if (ctx.vfs !== undefined) {
    const scope = resolveTarget(target, ctx.cwd.virtual)
    try {
      await ctx.vfs.dispatch('write', scope, [data])
    } catch (err) {
      if (!isWalkError(err)) throw err
      // GNU wget opens the -O file before it fetches and answers a refused
      // open as `NAME: strerror`, exit 1, which -q does not silence (wget
      // 1.25.0). A stamped error's message is its path, so the strerror
      // phrase stands alone.
      const detail = fsStrerror(err) ?? (err instanceof Error ? err.message : String(err))
      return [
        null,
        new IOResult({ exitCode: EXIT_GENERIC, stderr: ENC.encode(`${dest}: ${detail}\n`) }),
      ]
    }
  }
  if (isHttpError(resp)) {
    const line = `ERROR ${String(resp.status)}: ${resp.reason}.\n`
    return [null, new IOResult({ exitCode: EXIT_SERVER_ERROR, stderr: said(q, line) })]
  }
  // Real wget puts its progress report on stderr and nothing on stdout.
  const line = `'${dest}' saved [${String(data.byteLength)}/${String(data.byteLength)}]\n`
  return [null, new IOResult({ stderr: said(q, line) })]
}

export const GENERAL_WGET = command({
  name: 'wget',
  vfs: null,
  spec: specOf('wget'),
  fn: wget,
})
