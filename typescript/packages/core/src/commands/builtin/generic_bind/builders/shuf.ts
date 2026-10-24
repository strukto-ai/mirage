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

import { NO_WRITE_OP, shufGeneric } from '../../generic/shuf.ts'
import { type GenericCommand } from '../adapter.ts'
import { commandFiles, resolveOrEmpty } from '../files.ts'

export const BUILDER: GenericCommand = {
  name: 'shuf',
  write: true,
  read: true,
  fn: async (_accessor, paths, texts, ctx) => {
    const files = commandFiles(ctx, paths)
    const resolved = await resolveOrEmpty(files, paths)
    return shufGeneric(
      resolved,
      texts,
      ctx,
      files.read,
      // Only `-o` writes, so a read-only backend still serves plain shuf.
      // Requiring the write op up front would break every read-only backend.
      (p, data) => {
        if (!files.answers('write')) throw new Error(NO_WRITE_OP)
        return files.write(p, data)
      },
    )
  },
}
