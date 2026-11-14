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

import { Channel, type JobConsole, JobOutput, type OwnedStream } from '../../shell/console/index.ts'

/**
 * What a child holds open of a capture: what its descriptors that lead into
 * the capture named as it started (`&1`, `&2`, a copy), until its shell
 * points every descriptor elsewhere (`exec 2>/dev/null`), as bash's capture
 * ends once each writer has closed the pipe. Mirrors Python's Hold.
 */
export class Hold {
  readonly released: Promise<void>
  private release: () => void = () => undefined

  /** @param named what those descriptors named. */
  constructor(readonly named: ReadonlySet<string>) {
    this.released = new Promise((resolve) => {
      this.release = resolve
    })
  }

  /**
   * Let go of the capture once none of the shell's descriptors names what
   * led into it.
   *
   * @param named what the shell's descriptors name now.
   */
  settle(named: ReadonlySet<string>): void {
    for (const name of this.named) if (named.has(name)) return
    this.release()
  }
}

/**
 * The background jobs and process substitutions started inside a capture
 * (`$( )`, a pipe stage), which the capture waits for before it ends: bash
 * reads the pipe until every writer has closed it, and a child holds it
 * open for as long as one of its streams leads into it.
 */
export class JobWaits {
  readonly ends: (() => Promise<void>)[] = []

  /**
   * @param output where the capture's jobs write, at its edge.
   * @param channels what the capture reads there: stdout, and stderr too
   *   for a stage piped with `|&`.
   */
  constructor(
    readonly output: JobOutput,
    readonly channels: ReadonlySet<Channel> = new Set([Channel.STDOUT]),
  ) {}

  /**
   * Whether a job writing `streams` where `from` leads writes into the
   * capture. A redirect on the way (`JobRoute`) may send them elsewhere;
   * a stream that no level on the way owns is counted, as it may be the
   * capture's.
   */
  reaches(from: JobConsole, streams: ReadonlySet<Channel | OwnedStream>): boolean {
    let at = from
    let left = new Set(streams)
    while (at !== this.output) {
      if (!(at instanceof JobOutput)) return true
      left = at.passes(left)
      at = at.target
    }
    for (const stream of left)
      if (typeof stream !== 'string' || this.channels.has(stream)) return true
    return false
  }

  /**
   * Count a child the capture has to outlast, until it ends or lets go of
   * the capture (`Hold`).
   *
   * @param ended resolves once the child has ended.
   * @param named what the child's descriptors that lead into the capture
   *   named as it started.
   */
  add(ended: () => Promise<void>, named: ReadonlySet<string>): Hold {
    const hold = new Hold(named)
    this.ends.push(() => {
      const finished = ended()
      // A wait that fails before the child lets go fails the join; one that
      // fails after is no longer the capture's.
      void hold.released.then(() =>
        finished.catch((error: unknown) => {
          console.debug('waiting for a child that let go failed', error)
        }),
      )
      return Promise.race([finished, hold.released])
    })
    return hold
  }

  /**
   * Return once every child writing into the capture has ended; what the
   * capture's other children write from then on goes to `rest`, where the
   * capture's caller writes.
   */
  async join(rest: JobConsole): Promise<void> {
    // A child added while this waits is still reached: the loop reads the
    // list as it grows.
    for (const ended of this.ends) await ended()
    this.output.target = rest
  }
}
