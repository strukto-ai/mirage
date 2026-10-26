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

import type { ConsoleStore } from '../console/index.ts'
import type { RecordFields } from '../../workspace/record/types.ts'

/**
 * Storage seam for the job plane: each session's job list, each job's
 * console, and which owners still run their jobs.
 *
 * A session's list is one record, `{"next": n, "jobs": {id: job}}`,
 * written under a generation CAS the way the session table is, so two
 * workspaces that start a job on one session at once never hand out the
 * same number. A job's console is a stream the record names; any workspace
 * on the same store attaches to it by that name, follows it, and ends it
 * to kill the job. A lease says an owner is still alive: a job whose
 * owner's lease lapsed with no ending was lost with it.
 *
 * Subclasses are infra adapters (RAM, Redis); everything above (job
 * numbers, waits, kills, hangups) is the table's, mirroring the
 * NamespaceStore design. Mirrors Python's `JobStore`.
 */
export abstract class JobStore {
  /**
   * @param leaseSeconds how long an owner's renewal keeps it alive; null
   *   means owners never lapse, which holds where every owner shares one
   *   process.
   */
  constructor(readonly leaseSeconds: number | null = null) {}

  /** Read one session's job list; null when never written. */
  abstract load(sessionId: string): Promise<RecordFields | null>

  /**
   * Write one session's job list iff its generation matches. Same contract
   * as `NamespaceStore.casSet`: a missing record counts as generation 0.
   */
  abstract casSet(
    sessionId: string,
    fields: RecordFields,
    expectedGeneration: number,
  ): Promise<boolean>

  /** Drop one session's job list (the session closed). */
  abstract delete(sessionId: string): Promise<void>

  /**
   * The console stream a job list names. Every call for one name reaches
   * the same stream, so the job's owner writes it and any other workspace
   * reads or ends it.
   */
  abstract console(name: string): ConsoleStore

  /**
   * Keep an owner alive for another `leaseSeconds`, and the consoles of
   * the jobs it still runs with it. A store that expires consoles pushes
   * their expiry out here, so a quiet job keeps its output while its owner
   * lives, and loses it a while after the owner dies with nobody left to
   * end it.
   */
  abstract renew(owner: string, consoles?: readonly string[]): Promise<void>

  /** Whether an owner's lease still holds. */
  abstract alive(owner: string): Promise<boolean>

  /** Delete every job list, console and lease. */
  abstract clear(): Promise<void>

  /** Release any held connections. */
  abstract close(): Promise<void>
}
