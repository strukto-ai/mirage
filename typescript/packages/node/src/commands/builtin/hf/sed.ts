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

import { makeSed } from '@struktoai/mirage-core'
import type { HfAccessor } from '../../../accessor/hf.ts'
import { HF_RESOURCES } from '../../../accessor/hf.ts'
import { stream as hfStream } from '../../../core/hf/stream.ts'
import { stat as hfProvStat } from '../../../core/hf/stat.ts'
import { write as hfWrite } from '../../../core/hf/write.ts'

export const HF_SED = makeSed<HfAccessor>({
  stat: (a, p) => hfProvStat(a, p),
  resource: [...HF_RESOURCES],
  stream: (a, p) => hfStream(a, p),
  write: (a, p, d) => hfWrite(a, p, d),
})
