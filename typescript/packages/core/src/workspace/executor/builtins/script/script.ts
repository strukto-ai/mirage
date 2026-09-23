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

import { resolvePath } from '../../../../utils/path.ts'
import { materialize, IOResult } from '../../../../io/types.ts'
import type { ByteSource } from '../../../../io/types.ts'
import { FileType } from '../../../../types.ts'
import { eisdir, fsStrerror } from '../../../../utils/errors.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { resolvePathStat } from '../links/index.ts'
import { toScope } from '../scope.ts'
import type { Result } from '../types.ts'

/**
 * A diagnostic from a shell that never got as far as running.
 *
 * `prefix` and `command` come apart because bash reports itself by
 * `argv[0]`, which for a script operand is the operand: the recorded
 * command still has to be the builtin that ran, not a file path.
 */
export function scriptError(
  prefix: string,
  message: string,
  code: number,
  command?: string,
): Result {
  const err = new TextEncoder().encode(`${prefix}: ${message}\n`)
  return [
    null,
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({ command: command ?? prefix, exitCode: code, stderr: err }),
  ]
}

/**
 * Read a script file through the op dispatcher.
 *
 * Every way of running a script off a mount comes through here, so a backend
 * quirk is answered once rather than per caller. The one answered today is a
 * directory, which only a real filesystem reports as EISDIR on read: a keyed
 * backend has no directory object to open and answers ENOENT, ssh's raw error
 * carries no errno, and WebDAV serves the collection's HTML listing as bytes,
 * which a loader that read first would then run as a script. So the stat
 * probe runs before the read, and asks both channels a backend can answer on,
 * since on a prefix store a directory is the set of keys under it rather than
 * an object. A stat miss alone proves nothing (absence takes two channels), so
 * only a positive directory answer is acted on and the read still owns "no
 * such file".
 *
 * The caller owns the diagnostic: `source` and a nested shell word the same
 * failure differently and exit differently on it.
 */
export async function readScriptText(
  dispatch: DispatchFn,
  path: string,
  cwd: string,
): Promise<string> {
  const scope = toScope(resolvePath(path, cwd))
  const stat = await resolvePathStat(dispatch, scope)
  if (stat !== null && stat.type === FileType.DIRECTORY) throw eisdir(path)
  const [data] = await dispatch('read', scope)
  if (data instanceof Uint8Array) return new TextDecoder().decode(data)
  if (data === null || data === undefined) return ''
  return new TextDecoder().decode(await materialize(data as ByteSource))
}

/**
 * Read a script file operand, or the failure bash reports for it.
 *
 * GNU splits the diagnostics by how far startup got, and both halves fall out
 * of the errno rather than being listed case by case. A file the shell cannot
 * open at all is blamed on the shell, and only a missing one is exit 127
 * (`bash: run.sh: No such file or directory`); anything it found but could not
 * run is 126 (`Permission denied`, `Not a directory`). A directory is the
 * exception, because it opens fine and fails on the first read, by which point
 * `$0` is already the operand, so bash prints it twice (`/tmp: /tmp: Is a
 * directory`, exit 126). Reproduced rather than tidied up: it is what an agent
 * copying a message into a search box will find.
 */
export async function readScriptFile(
  dispatch: DispatchFn,
  name: string,
  path: string,
  session: SessionState,
): Promise<[string, null] | [null, Result]> {
  try {
    return [await readScriptText(dispatch, path, session.cwd), null]
  } catch (exc) {
    // A strerror is exactly what makes this a filesystem error, so the
    // lookup is both the test and the message.
    const strerror = fsStrerror(exc)
    if (strerror === null) throw exc
    const code = (exc as { code?: string }).code
    if (code === 'EISDIR') {
      return [null, scriptError(path, `${path}: ${strerror}`, 126, name)]
    }
    return [null, scriptError(name, `${path}: ${strerror}`, code === 'ENOENT' ? 127 : 126)]
  }
}
