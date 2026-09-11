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

import type { PathSpec } from '../../../../../types.ts'
import { runCmp } from './cmp.ts'
import { runComm } from './comm.ts'
import { runCp } from './cp.ts'
import { runDiff } from './diff.ts'
import { runJoin } from './join.ts'
import { runLs } from './ls.ts'
import { runMv } from './mv.ts'
import { runPaste } from './paste.ts'
import { runTar } from './tar.ts'
import { runUnzip } from './unzip.ts'
import { Cmd, type CrossResult, type DispatchFn } from '../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import type { NamespaceView, SessionView } from '../../../../../ops/types.ts'

// Run a command whose work must see every operand at once. Pure wiring:
// every operand is read or written through dispatch primitives on its owning
// mount, and the shared generic does the work in its primitive mode, so
// output matches the single-mount commands.
export async function runRelay(
  cmdName: Cmd,
  scopes: PathSpec[],
  textArgs: string[],
  flagKwargs: Record<string, FlagValue>,
  dispatch: DispatchFn,
  // Maps an operand to its storage identity, for the transfer commands
  // that must tell a real move from one whose two prefixes address a
  // single store.
  storageKey?: (path: PathSpec) => string,
  // Name-plane facts for the generics that render them (ls: links, attr
  // overlay, child mounts).
  ns?: NamespaceView,
  // The session plane's door, for the generic that renders the session's
  // profile (ls -l).
  sessionView?: SessionView,
): Promise<CrossResult> {
  if (cmdName === Cmd.LS) return runLs(scopes, flagKwargs, dispatch, ns, sessionView)
  if (cmdName === Cmd.CP) return runCp(scopes, flagKwargs, dispatch, storageKey)
  if (cmdName === Cmd.MV) return runMv(scopes, flagKwargs, dispatch, storageKey)
  if (cmdName === Cmd.DIFF) return runDiff(scopes, flagKwargs, dispatch)
  if (cmdName === Cmd.PASTE) return runPaste(scopes, flagKwargs, dispatch)
  if (cmdName === Cmd.COMM) return runComm(scopes, flagKwargs, dispatch)
  if (cmdName === Cmd.JOIN) return runJoin(scopes, flagKwargs, dispatch)
  if (cmdName === Cmd.TAR) return runTar(textArgs, flagKwargs, dispatch)
  if (cmdName === Cmd.UNZIP) return runUnzip(scopes, textArgs, flagKwargs, dispatch)
  return runCmp(scopes, flagKwargs, dispatch)
}
