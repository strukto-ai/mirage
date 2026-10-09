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

import type { ByteSource } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import { runAwk } from './awk.ts'
import { runCp } from './cp.ts'
import { runLs } from './ls.ts'
import { runMv } from './mv.ts'
import { runSed } from './sed.ts'
import { runTar } from './tar.ts'
import { runTee } from './tee.ts'
import { runUnzip } from './unzip.ts'
import { runWc } from './wc.ts'
import { runZip } from './zip_cmd.ts'
import { DISPATCH_BUILDERS, RELAY_COMMANDS } from '../constants.ts'
import { runDispatch } from '../../../generic_bind/dispatch.ts'
import type { CrossResult, DispatchFn, RunSingle } from '../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import type { NamespaceView, SessionView } from '../../../../../view/types.ts'

// Run a command whose work must see every operand at once. Pure wiring:
// every operand is read or written through dispatch primitives on its owning
// mount, and the shared generic does the work in its primitive mode, so
// output matches the single-mount commands.
export async function runRelay(
  cmdName: string,
  scopes: PathSpec[],
  textArgs: string[],
  flagKwargs: Record<string, FlagValue>,
  dispatch: DispatchFn,
  // Single-mount runner: wc counts each operand with its own mount's wc,
  // since a mount can count without reading; only its layout spans the line.
  // awk runs once on its first file's mount, reading the rest through the
  // dispatcher, so every operand keeps its own name.
  runSingle: RunSingle,
  // Maps an operand to its storage identity, for the transfer commands
  // that must tell a real move from one whose two prefixes address a
  // single store.
  storageKey?: (path: PathSpec) => string,
  // Name-plane facts for the generics that render them (ls: links, attr
  // overlay, child mounts) and for the archivers' scan (tar, zip: links,
  // mount boundaries).
  ns?: NamespaceView,
  // The session view, for the generic that renders the session's
  // profile (ls -l).
  sessionView?: SessionView,
  stdin: ByteSource | null = null,
  // The session's working directory, which cp resolves a typed link source
  // against.
  cwd = '/',
  argv: readonly string[] = [],
  checkUnlink?: (path: PathSpec) => void,
): Promise<CrossResult> {
  if (!RELAY_COMMANDS.has(cmdName))
    throw new Error(`Unsupported cross-mount relay command: ${cmdName}`)
  if (cmdName === 'awk') return runAwk(scopes, textArgs, flagKwargs, runSingle, stdin)
  if (cmdName === 'sed')
    return runSed(scopes, textArgs, flagKwargs, dispatch, stdin, cwd, argv, sessionView?.snapshot())
  if (cmdName === 'wc') return runWc(scopes, flagKwargs, dispatch, runSingle, cwd, ns, stdin)
  if (cmdName === 'ls') return runLs(scopes, flagKwargs, dispatch, ns, sessionView)
  if (cmdName === 'cp') return runCp(scopes, flagKwargs, dispatch, storageKey, ns, cwd, stdin)
  if (cmdName === 'mv') {
    return runMv(scopes, flagKwargs, dispatch, storageKey, ns, stdin, checkUnlink)
  }
  if (cmdName === 'tar') return runTar(scopes, textArgs, flagKwargs, dispatch, ns, stdin)
  if (cmdName === 'tee') return runTee(scopes, flagKwargs, dispatch, stdin)
  if (cmdName === 'unzip') return runUnzip(scopes, textArgs, flagKwargs, dispatch)
  if (cmdName === 'zip') return runZip(scopes, flagKwargs, dispatch, ns)
  const builder = DISPATCH_BUILDERS.get(cmdName)
  if (builder !== undefined) {
    return runDispatch(
      builder,
      scopes,
      textArgs,
      flagKwargs,
      dispatch,
      cwd,
      ns,
      stdin,
      undefined,
      argv,
    )
  }
  throw new Error(`No cross-mount composition for ${cmdName}`)
}
