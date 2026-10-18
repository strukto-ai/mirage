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
import type { PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type Context } from '../../config.ts'
import { LanguageRuntime } from '../../../runtime/language.ts'
import { scriptOperand } from '../../../runtime/source.ts'
import type { FlagValue } from '../../spec/types.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { execRefusal, notBound, runInterpreter, runtimeVersion } from './interpreter.ts'

async function pythonCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const named = ctx.spec?.name ?? ''
  const label = named === '' ? 'python3' : named
  const runtime = ctx.runtime?.bound
  if (!(runtime instanceof LanguageRuntime)) return notBound(label)
  const fl = new FlagView(ctx.flags, specOf('python3'))
  if (fl.asBool('version')) {
    return runtimeVersion(label, runtime, ctx.env ?? {}, ctx.signal, ctx.timeoutSeconds)
  }
  // The runtime's switches, keyed by CPython's own letter, which is how
  // runtime/python/flags reads them; the one long switch is keyed by its
  // canonical spelling, having no letter. -u and -q are absent because
  // mirage buffers every stream and prints no banner, so no engine can
  // differ on them.
  const switches: Record<string, FlagValue> = {
    b: fl.asInt('b') ?? 0,
    B: fl.asBool('B'),
    E: fl.asBool('E'),
    // -I and -O canonicalize to args_I/args_O (AMBIGUOUS_NAMES), so the
    // spec-checked FlagView refuses the bare letters.
    I: fl.asBool('args_I'),
    O: fl.asInt('args_O') ?? 0,
    P: fl.asBool('P'),
    s: fl.asBool('s'),
    S: fl.asBool('S'),
    W: fl.asList('W'),
    X: fl.asList('X'),
    x: fl.asBool('x'),
  }
  for (const [key, value] of [
    ['c', fl.asStr('c')],
    ['m', fl.asStr('m')],
    ['check_hash_based_pycs', fl.asStr('check_hash_based_pycs')],
  ] as const) {
    if (value !== undefined) switches[key] = value
  }
  const script = scriptOperand(paths, texts, switches, ctx.cwd)
  const refusal = execRefusal(label, script, ctx.runtime)
  if (refusal !== null) return refusal
  return runInterpreter(label, runtime, paths, texts, { ...ctx, flags: switches }, script)
}

export const GENERAL_PYTHON3 = command({
  name: 'python3',
  vfs: null,
  spec: specOf('python3'),
  write: true,
  fn: pythonCommand,
})

export const GENERAL_PYTHON = command({
  name: 'python',
  vfs: null,
  spec: specOf('python'),
  write: true,
  fn: pythonCommand,
})
