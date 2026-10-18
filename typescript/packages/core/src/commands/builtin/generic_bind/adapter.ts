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
import type { AggregateFn, CommandFn } from '../../config.ts'

/**
 * A generic builder: its name, how its runs register, and its handler, an
 * ordinary command handler that reads and writes only through the session's
 * files (`commandFiles(ctx, paths)`). Mirrors Python's `GenericCommand`.
 */
export interface GenericCommand<A extends Accessor = Accessor> {
  name: string
  fn: CommandFn<A>
  write?: boolean
  aggregate?: AggregateFn
  read?: boolean
  /**
   * The command hands on what it reads (`cat`, `head -c`), so its input keeps
   * the producer's chunks instead of the 16 KiB pieces a scan reads. It then
   * writes a pipe in the writes the producer made, and a write the reader's
   * close cuts short is its SIGPIPE, as in Python, which passes every chunk
   * through. A scan inside such a command splits its own input.
   */
  passThrough?: boolean
  /**
   * The command only reads its operands while its output drains (`comm`,
   * `fold`), so a cross-mount run hands that output on live.
   */
  streams?: boolean
}
