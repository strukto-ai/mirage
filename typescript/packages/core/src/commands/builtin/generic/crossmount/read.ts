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

import type { PathSpec } from '../../../../types.ts'
import { catGeneric } from '../cat.ts'
import { grepGeneric } from '../grep.ts'
import { headGeneric } from '../head.ts'
import { rgGeneric } from '../rg.ts'
import { tailGeneric } from '../tail.ts'
import { wcGeneric } from '../wc.ts'
import {
  crossOpts,
  type CrossResult,
  type DispatchFn,
  readdirOp,
  statOp,
  streamOp,
} from './primitives.ts'

// Aggregate a multi-file read whose operands span mounts. Each operand is read
// (and for grep stat'd/readdir'd) through its owning mount via dispatch-relayed
// primitives, and the shared generic does the cat/head/tail/wc/grep work, so
// output matches the single-mount commands. Scopes keep their prefixes: the
// read generics key output off `original`, not mount arithmetic.
export async function runRead(
  cmdName: string,
  scopes: PathSpec[],
  textArgs: string[],
  flagKwargs: Record<string, string | boolean | string[]>,
  dispatch: DispatchFn,
): Promise<CrossResult> {
  const opts = crossOpts(flagKwargs)
  const stat = statOp(dispatch)
  const readdir = readdirOp(dispatch)
  const stream = streamOp(dispatch)

  if (cmdName === 'grep') {
    const [out, io] = await grepGeneric('grep', scopes, textArgs, opts, stat, readdir, stream)
    return [out, io]
  }
  if (cmdName === 'rg') {
    const [out, io] = await rgGeneric(scopes, textArgs, opts, stat, readdir, stream)
    return [out, io]
  }
  if (cmdName === 'head') {
    const [out, io] = await headGeneric(scopes, textArgs, opts, stat, stream)
    return [out, io]
  }
  if (cmdName === 'tail') {
    const [out, io] = await tailGeneric(scopes, textArgs, opts, stream)
    return [out, io]
  }
  if (cmdName === 'wc') {
    const [out, io] = await wcGeneric(scopes, textArgs, opts, stream)
    return [out, io]
  }
  const [out, io] = await catGeneric(scopes, textArgs, opts, stat, stream)
  return [out, io]
}
