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

import { fsStrerror, isEisdir, isFsError } from '../../../errors/fs.ts'
import type { PathSpec } from '../../../types.ts'
import { concat } from '../../../utils/bytes.ts'
import { shellQuote, shellQuoteAlways } from '../../../utils/quote.ts'

/**
 * A `--random-source` file that could not hand out the bytes asked for,
 * worded as the command says it, without the trailing newline.
 */
export class RandomSourceError extends Error {}

/**
 * The bytes a `--random-source` file hands out, in order, read only as they
 * are asked for, so a file nothing draws from is never opened. `opening` names
 * the step a refused open is reported by (`open failed`), or null to name the
 * file alone. Mirrors Python's `RandomSource`.
 */
export class RandomSource {
  private cursor: AsyncIterator<Uint8Array> | null = null
  private held: Uint8Array = new Uint8Array()

  constructor(
    readonly cmd: string,
    readonly path: PathSpec,
    readonly stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
    readonly opening: string | null = null,
  ) {}

  /** The next `count` bytes; throws `RandomSourceError` when it cannot. */
  async take(count: number): Promise<Uint8Array> {
    this.cursor ??= this.stream(this.path)[Symbol.asyncIterator]()
    const label = this.path.rawPath
    while (this.held.length < count) {
      let step: IteratorResult<Uint8Array>
      try {
        step = await this.cursor.next()
      } catch (e) {
        if (!isFsError(e)) throw e
        if (isEisdir(e)) {
          throw new RandomSourceError(
            `${this.cmd}: ${shellQuoteAlways(label)}: read error: ${fsStrerror(e) ?? ''}`,
          )
        }
        const prefix = this.opening === null ? '' : `${this.opening}: `
        throw new RandomSourceError(
          `${this.cmd}: ${prefix}${shellQuote(label)}: ${fsStrerror(e) ?? ''}`,
        )
      }
      if (step.done === true) {
        throw new RandomSourceError(`${this.cmd}: ${shellQuoteAlways(label)}: end of file`)
      }
      this.held = concat([this.held, step.value])
    }
    const taken = this.held.slice(0, count)
    this.held = this.held.slice(count)
    return taken
  }

  async close(): Promise<void> {
    await this.cursor?.return?.()
  }
}
