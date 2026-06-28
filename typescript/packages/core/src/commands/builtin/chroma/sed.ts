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

import type { ChromaAccessor } from '../../../accessor/chroma.ts'
import { resolveGlob } from '../../../core/chroma/glob.ts'
import { readStream } from '../../../core/chroma/read.ts'
import { ResourceName } from '../../../types.ts'
import { makeSed } from '../generic/sed_command.ts'

export const CHROMA_SED = makeSed<ChromaAccessor>({
  resource: ResourceName.CHROMA,
  stream: (a, p, opts) => readStream(a, p, opts.index ?? undefined),
  glob: (a, paths, opts) => resolveGlob(a, paths, opts.index ?? undefined),
  readOnlyMount: 'Chroma',
})
