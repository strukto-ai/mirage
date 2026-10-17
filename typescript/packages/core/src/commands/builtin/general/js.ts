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

async function js(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const named = ctx.spec?.name ?? ''
  const label = named === '' ? 'js' : named
  const runtime = ctx.runtime?.bound
  if (!(runtime instanceof LanguageRuntime)) return notBound(label)
  const fl = new FlagView(ctx.flags, specOf('js'))
  if (fl.asBool('version')) {
    return runtimeVersion(label, runtime, ctx.env ?? {}, ctx.signal, ctx.timeoutSeconds)
  }
  const switches: Record<string, FlagValue> = {}
  const payload = fl.asStr('e')
  if (payload !== undefined) switches.c = payload
  const script = scriptOperand(paths, texts, switches, ctx.cwd)
  const refusal = execRefusal(label, script, ctx.runtime)
  if (refusal !== null) return refusal
  // A .mjs script is a module whatever the flag said.
  switches.module = fl.asBool('module') || (script?.virtual.endsWith('.mjs') ?? false)
  return runInterpreter(label, runtime, paths, texts, { ...ctx, flags: switches }, script)
}

export const GENERAL_JS = command({
  name: 'js',
  vfs: null,
  spec: specOf('js'),
  fn: js,
})

export const GENERAL_NODE = command({
  name: 'node',
  vfs: null,
  spec: specOf('node'),
  fn: js,
})
