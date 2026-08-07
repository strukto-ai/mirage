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

import type { JaegerAccessor } from '../../../accessor/jaeger.ts'
import { read as jaegerRead } from '../../../core/jaeger/read.ts'
import { readdir as jaegerReaddir } from '../../../core/jaeger/readdir.ts'
import { stat as jaegerStat } from '../../../core/jaeger/stat.ts'
import type { CommandIO } from '../generic_bind/index.ts'
import { streamFromBytes } from '../utils/wrap.ts'

export const JAEGER_IO: CommandIO<JaegerAccessor> = {
  readdir: jaegerReaddir,
  readBytes: jaegerRead,
  readStream: (a, p, i) => streamFromBytes(jaegerRead, a, p, i),
  stat: jaegerStat,
  isMounted: () => true,
  local: false,
}
