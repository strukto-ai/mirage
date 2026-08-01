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
import { FlagView } from '../../spec/types.ts'
import { IOResult } from '../../../io/types.ts'
import type { CommandFn } from '../../config.ts'
import { gnuBasename } from '../../../utils/path.ts'

const ENC = new TextEncoder()

export const basenameFn: CommandFn = (_accessor, _paths, texts, opts) => {
  const fl = new FlagView(opts.flags, specOf('basename'))
  const suffixValue = fl.asStr('s') ?? fl.asStr('suffix')
  const suffix = typeof suffixValue === 'string' ? suffixValue : undefined
  const multiple = fl.asBool('a') || fl.asBool('multiple') || suffix !== undefined
  const lines =
    suffix !== undefined
      ? texts.map((text) => gnuBasename(text, suffix))
      : texts.length === 2 && !multiple
        ? [gnuBasename(texts[0] ?? '', texts[1])]
        : texts.map((text) => gnuBasename(text))
  const separator = fl.asBool('z') || fl.asBool('zero') ? '\0' : '\n'
  return [ENC.encode(lines.join(separator) + separator), new IOResult()]
}
