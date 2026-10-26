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

import { z } from 'zod'
import { DEFAULT_TIMEOUT } from './constants.ts'

export const timeoutShape = {
  timeout: z.number().positive().optional().meta({
    description:
      'Seconds a request may wait to connect, or between two reads of its answer, before it fails; a download that keeps flowing is never cut off.',
    default: DEFAULT_TIMEOUT,
  }),
}
