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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { posixNormpath } from '../../../utils/path.ts'
import { missingOperandError } from '../../spec/usage.ts'

const ENC = new TextEncoder()

interface ReadlinkFlags {
  readonly canonicalize: boolean
  readonly canonicalizeExisting: boolean
  readonly canonicalizeMissing: boolean
  readonly noNewline: boolean
}

function parseFlags(bag: Record<string, FlagValue>): ReadlinkFlags {
  const fl = new FlagView(bag, specOf('readlink'))
  return {
    canonicalize: fl.asBool('canonicalize'),
    canonicalizeExisting: fl.asBool('canonicalize_existing'),
    canonicalizeMissing: fl.asBool('canonicalize_missing'),
    noNewline: fl.asBool('no_newline'),
  }
}

export function readlinkGeneric(
  paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): CommandFnResult {
  if (paths.length === 0) throw missingOperandError('readlink', null)
  const parsed = parseFlags(ctx.flags)
  const normalize = parsed.canonicalize || parsed.canonicalizeExisting || parsed.canonicalizeMissing
  const noNewline = parsed.noNewline
  const results: string[] = []
  for (const p of paths) {
    results.push(normalize ? posixNormpath(p.virtual) : p.virtual)
  }
  let text = results.join('\n')
  if (!noNewline) text += '\n'
  const out: ByteSource = ENC.encode(text)
  return [out, new IOResult()]
}
