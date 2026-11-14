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

import { shellVoice } from '../../../../shell/voice.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import { enoent, fsStrerror, isMissingPath } from '../../../../errors/fs.ts'
import type { ByteSource, IOResult } from '../../../../io/types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { CallStack } from '../../../../shell/call_stack.ts'
import type { JobConsole } from '../../../../shell/console/index.ts'
import { ExitSignal, ReturnSignal } from '../../../../shell/errors.ts'
import type { PathSpec } from '../../../../types.ts'
import { wordText } from '../../../../types.ts'
import { argsBytes, checkEnv, framesBytes } from '../../../session/budget.ts'
import type { SessionState } from '../../../session/session.ts'
import { positionalParams, setPositionalParams, visibleEnv } from '../../../session/state.ts'
import { ExecutionNode } from '../../../types.ts'
import { ended, returning } from '../../control.ts'
import { scopePath } from '../scope.ts'
import { builtinUsage } from '../shared.ts'
import type { BuiltinCall } from '../types.ts'
import type { ExecuteFn } from '../../../expand/types.ts'
import { readScriptText, scriptError } from './script.ts'

/**
 * The file `source` reads, as `BASH_SOURCE` names it, and its text: a name
 * with no slash is looked up on PATH first under `sourcepath`, then, outside
 * posix mode, in the working directory. Mirrors Python's `_source_file`.
 */
async function sourceFile(
  dispatch: DispatchFn,
  session: SessionState,
  path: string | PathSpec,
): Promise<[string, string]> {
  const name = wordText(path)
  if (!name.includes('/') && (session.shopts.sourcepath ?? true)) {
    const search = visibleEnv(session).PATH
    if (search !== undefined) {
      for (const directory of search.split(':')) {
        const candidate = directory ? directory.replace(/\/+$/, '') + '/' + name : name
        try {
          return [candidate, await readScriptText(dispatch, candidate, session.cwd)]
        } catch (error) {
          const code = (error as { code?: string }).code
          if (!isMissingPath(error) && code !== 'ENOTDIR' && code !== 'EISDIR') throw error
        }
      }
      if (session.shellOptions.posix) throw enoent(name)
    }
  }
  return [name, await readScriptText(dispatch, scopePath(path), session.cwd)]
}

/**
 * Read a script file and execute it in the calling shell, `name` (`source`
 * or `.`) as typed. A sourced file is the caller, so whatever it sets stays
 * set; arguments replace `$1..$#` while it runs, and a `set --` in it outside
 * a function replaces the caller's too. It runs in a frame of its own, which
 * `return` ends, `FUNCNAME` names `source` and the RETURN action runs in as it
 * returns; a `break` in it ends a caller's loop. An empty name fails as a
 * missing file does, and bash blames a file it cannot read on itself, not the
 * builtin.
 */
export async function handleSource(
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  path: string | PathSpec,
  session: SessionState,
  args: string[] = [],
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  sink?: JobConsole,
  name = 'source',
): Promise<RedirectResult> {
  const raw = scopePath(path)
  if (wordText(path) === '') {
    return scriptError(shellVoice(), 'No such file or directory', 1, 'source ')
  }
  let origin: string
  let script: string
  try {
    ;[origin, script] = await sourceFile(dispatch, session, path)
  } catch (err) {
    const strerror = fsStrerror(err)
    if (strerror === null) throw err
    if ((err as { code?: unknown }).code === 'EISDIR') {
      return scriptError(`${shellVoice()}${name}`, `${raw}: is a directory`, 1, `source ${raw}`)
    }
    return scriptError(`${shellVoice()}${raw}`, strerror, 1, `source ${raw}`)
  }
  const cs = callStack ?? new CallStack(session.shellNesting)
  cs.admit(name)
  const params = args.length > 0 ? args : [...positionalParams(session, cs)]
  checkEnv(session, 0, argsBytes(params), framesBytes(cs))
  cs.push(params, 'source', true, session.lineNumber)
  const outerNames = session.functionNames
  if (outerNames !== null) session.functionNames = cs.functionNames()
  const outerLines = session.callLines
  session.callLines = cs.callLines()
  // Its diagnostics name the file, as spelled, and count its own lines.
  const outerName = session.parseName
  const outerHead = session.parseHead
  const outerSources = session.sourceFiles
  session.sourceFiles = [origin, ...outerSources]
  session.parseName = origin
  session.parseHead = `${session.parseName}: `
  session.parseFrom = 0
  let io: IOResult
  let stdout: ByteSource | null
  try {
    try {
      io = await executeFn(script, {
        sessionId: session.sessionId,
        stdin,
        callStack: cs,
        ...(sink === undefined ? {} : { sink }),
      })
    } catch (err) {
      if (!(err instanceof ReturnSignal)) throw err
      io = ended(err)
    } finally {
      // The RETURN trap speaks as the caller, as bash's does.
      session.parseName = outerName
      session.parseHead = outerHead
      session.parseFrom = null
    }
    ;[stdout, io] = await returning(executeFn, session, stdin, cs, io.stdout, io)
  } catch (err) {
    if (err instanceof ExitSignal) err.sourced = true
    throw err
  } finally {
    const frame = cs.pop()
    if (session.functionNames !== null) session.functionNames = outerNames
    session.callLines = outerLines
    session.sourceFiles = outerSources
    // A file sourced with no arguments shares its caller's, so a `set --` in
    // it is the caller's own; one given arguments hands back what a `set --`
    // made of them, outside a function only.
    if (args.length === 0) cs.current.replacedArgs ||= frame.replacedArgs
    if (args.length === 0 || (frame.replacedArgs && cs.functionDepth === 0))
      setPositionalParams(session, cs, frame.positional)
  }
  return [stdout, io, new ExecutionNode({ command: `source ${raw}`, exitCode: io.exitCode })]
}

/**
 * The `source` / `.` arm. Positional parameters keep the words as typed,
 * so a path operand contributes its spelling, not its resolved mount path.
 */
export async function sourceBuiltin(call: BuiltinCall): Promise<RedirectResult> {
  const operands = [...call.argv.operands]
  const target = operands[0]
  const name = call.argv.name
  if (target === undefined) {
    return scriptError(
      `${shellVoice()}${name}`,
      `filename argument required\n${builtinUsage(name).trimEnd()}`,
      2,
      name,
    )
  }
  const sourceArgs = operands.slice(1).map((o) => wordText(o))
  return handleSource(
    call.dispatch,
    call.executeFn,
    target,
    call.context.session,
    sourceArgs,
    call.stdin,
    call.callStack,
    call.sink,
    name,
  )
}
