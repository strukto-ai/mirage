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
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { LanguageRuntime } from '../../../runtime/language.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { notBound, resolveSource, runCode, runtimeVersion } from './interpreter.ts'

async function js(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const label = opts.command ?? 'js'
  if (!(opts.runtime instanceof LanguageRuntime)) return notBound(label)
  const fl = new FlagView(opts.flags, specOf('js'))
  if (fl.asBool('version')) {
    return runtimeVersion(label, opts.runtime, opts.env ?? {}, opts.signal, opts.timeoutSeconds)
  }
  const prepared = await resolveSource(label, paths, texts, fl.asStr('e') ?? null, opts)
  if (Array.isArray(prepared) || prepared === null) return prepared
  // A .mjs script is a module whatever the flag said.
  const module = fl.asBool('module') || (prepared.scriptPath?.virtual.endsWith('.mjs') ?? false)
  return runCode(label, prepared, opts.runtime, { module }, opts)
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
