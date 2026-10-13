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
import { CPYTHON_ARGV0, notBound, resolveSource, runCode, runtimeVersion } from './interpreter.ts'
import type { InitFlags } from '../../../runtime/python/flags.ts'

// Keyed by CPython's own letter, which is how runtime/python/flags reads
// them; the one long switch is keyed by its canonical spelling, having
// no letter. -u and -q are absent because mirage buffers every stream
// and prints no banner, so no engine can differ on them, and -x is
// absent because it selects source rather than configuring an
// interpreter, so resolveSource answers it.
function initFlags(fl: FlagView): InitFlags {
  return {
    b: fl.asInt('b') ?? 0,
    B: fl.asBool('B'),
    E: fl.asBool('E'),
    // -I and -O canonicalize to args_I/args_O (AMBIGUOUS_NAMES), so the
    // spec-checked FlagView refuses the bare letters.
    I: fl.asBool('args_I'),
    P: fl.asBool('P'),
    s: fl.asBool('s'),
    S: fl.asBool('S'),
    O: fl.asInt('args_O') ?? 0,
    W: fl.asList('W'),
    X: fl.asList('X'),
    check_hash_based_pycs: fl.asStr('check_hash_based_pycs') ?? null,
  }
}

async function pythonCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const label = opts.command ?? 'python3'
  if (!(opts.runtime instanceof LanguageRuntime)) return notBound(label)
  const fl = new FlagView(opts.flags, specOf('python3'))
  if (fl.asBool('version')) {
    return runtimeVersion(label, opts.runtime, opts.env ?? {}, opts.signal, opts.timeoutSeconds)
  }
  const prepared = await resolveSource(
    label,
    paths,
    texts,
    fl.asStr('c') ?? null,
    opts,
    fl.asStr('m') ?? null,
    CPYTHON_ARGV0,
    fl.asBool('x'),
  )
  if (Array.isArray(prepared) || prepared === null) return prepared
  return runCode(label, prepared, opts.runtime, { ...initFlags(fl) }, opts)
}

export const GENERAL_PYTHON3 = command({
  name: 'python3',
  vfs: null,
  spec: specOf('python3'),
  fn: pythonCommand,
})

export const GENERAL_PYTHON = command({
  name: 'python',
  vfs: null,
  spec: specOf('python'),
  fn: pythonCommand,
})
