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
import { gnuDirname } from '../../../utils/path.ts'

const ENC = new TextEncoder()

export const dirnameFn: CommandFn = (_accessor, _paths, texts, opts) => {
  const lines = texts.map((t) => gnuDirname(t))
  const fl = new FlagView(opts.flags, specOf('dirname'))
  const separator = fl.asBool('zero') ? '\0' : '\n'
  return [ENC.encode(lines.join(separator) + separator), new IOResult()]
}
