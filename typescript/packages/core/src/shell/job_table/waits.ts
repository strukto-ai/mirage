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

import { Channel, type JobConsole, JobOutput, type OwnedStream } from '../console/index.ts'
import type { Job } from './types.ts'

/**
 * The background jobs started inside a capture (`$( )`, a pipe stage),
 * which the capture waits for before it ends: bash reads the pipe until
 * every writer has closed it, and a job holds it open for as long as one
 * of its streams leads into it.
 */
export class JobWaits {
  readonly jobs: Job[] = []

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

  /** Count a job the capture has to outlast. */
  add(job: Job): void {
    this.jobs.push(job)
  }

  /**
   * Return once every job writing into the capture has ended; what the
   * capture's other jobs write from then on goes to `rest`, where the
   * capture's caller writes.
   */
  async join(rest: JobConsole): Promise<void> {
    // A job added while this waits is still reached: the loop reads the
    // list as it grows.
    for (const job of this.jobs) await job.console.waitFinished()
    this.output.target = rest
  }
}
