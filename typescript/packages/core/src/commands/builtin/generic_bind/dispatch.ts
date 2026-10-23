import type { DiffComputer } from '../../../rs/diff_types.ts'
import type { IdSource } from '../../../utils/ids.ts'
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

import { chunks } from '../../../io/cooperative.ts'
import { NOOPAccessor } from '../../../accessor/base.ts'
import { materialize, IOResult } from '../../../io/types.ts'
import type { ByteSource } from '../../../io/types.ts'
import { FileType, PathSpec } from '../../../types.ts'
import { eisdir } from '../../../errors/fs.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { currentCaller, runWithCaller, type Caller } from '../../../context/session_context.ts'
import type { FollowOperands } from '../../../view/types.ts'
import { Files } from '../../../workspace/files.ts'
import type { FlagValue } from '../../spec/types.ts'
import type { GenericCommand } from './adapter.ts'
import { dispatchStat, virtualFlags, virtualKey } from '../utils/paths.ts'

/** A streamed read that opens as the command that asked for it: at the first
 * pull, which can come after that command ended, so under the command's
 * caller, as a `fresh` mount trusts only the listings that command made. A
 * directory fails with EISDIR, as a POSIX read does, before a keyed store
 * reads it as nothing. `ahead` is what the read awaits first (`readAhead`).
 * Mirrors Python's caller_stream. */
export async function* callerStream(
  dispatch: DispatchFn,
  caller: Caller,
  path: PathSpec,
  ahead?: (path: PathSpec) => Promise<void>,
): AsyncIterable<Uint8Array> {
  const data = await runWithCaller(caller, async () => {
    if ((await dispatchStat(dispatch)(path)).type === FileType.DIRECTORY) throw eisdir(path)
    await ahead?.(path)
    return (await dispatch('read', path, [], { stream: true }))[0] as ByteSource
  })
  yield* chunks(data)
}

/** Run the existing builder once over the full virtual namespace. Mirrors
 * Python's run_dispatch. The builder runs as a run across mounts: no mount's
 * command scope is bound around it (`crossesMounts`), so every call it makes
 * through its files reaches whichever mount serves the path. The dispatcher
 * lists the mounts below a directory itself, so no descendant is left to
 * avoid; where each mount begins stays for `--one-file-system`, and each
 * mount's du budget for a walk. `follow` is the line's operand resolution,
 * which its globs' matches take too. The output is read before this returns,
 * inside the running command: a `fresh` mount trusts only the listings that
 * command made, so a lazy stream read after it ends would be served the
 * previous command's. A builder that `streams` only reads, and each read opens
 * as this command (`callerStream`), so its output is handed on live. */
export async function runDispatch(
  builder: GenericCommand,
  paths: readonly PathSpec[],
  texts: readonly string[],
  bag: Record<string, FlagValue>,
  dispatch: DispatchFn,
  cwd: string,
  vfs?: Files,
  stdin: ByteSource | null = null,
  signal?: AbortSignal,
  argv: readonly string[] = [],
  follow?: FollowOperands,
  diff?: DiffComputer,
  ids?: IdSource,
): Promise<[ByteSource | null, IOResult]> {
  return runWithCaller({ ...currentCaller(), mount: null }, async () => {
    const result = await builder.fn(new NOOPAccessor(), paths.map(virtualKey), [...texts], {
      stdin,
      flags: virtualFlags(bag),
      cwd: PathSpec.fromStrPath(cwd),
      vfs: (
        vfs ?? new Files(dispatch, null, null, { follow: follow ?? null, ledger: false })
      ).servedBy(null),
      argv,
      ...(diff === undefined ? {} : { diff }),
      ...(ids === undefined ? {} : { ids }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (result === null) return [null, new IOResult()]
    if (builder.streams === true) return result
    return [await materialize(result[0]), result[1]]
  })
}
