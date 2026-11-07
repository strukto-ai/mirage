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

import type { ConsoleStore } from '../shell/console/index.ts'
import type { RecordFields } from '../workspace/record/types.ts'

/**
 * Storage seam for one workspace's execution plane: each session's job
 * list, each job's console, the workspace's lease, the processes each
 * daemon runs in it, and the stops asked of them.
 *
 * One daemon runs a workspace's processes at a time, for now: the one
 * holding its lease (`lease`). A daemon is one Mirage server or host
 * process, named by an id it keeps on disk, so a restarted one takes its
 * workspaces back at once. Any other daemon on the store reads the
 * workspace and signals what runs there, through the store: it lists the
 * jobs and processes, waits on a job's console, and asks the holder to
 * stop a process (`requestStop`), but it runs no line there while the
 * lease holds. Forwarding a line to the holder comes later.
 *
 * A session's list is one record, `{"next": n, "jobs": {id: job}}`,
 * written under a generation CAS the way the session table is, so two
 * daemons that number a job on one session at once never hand out the
 * same number. A job's console is a stream the record names; any daemon
 * on the same store attaches to it by that name, follows it, and ends it
 * to kill the job. A job whose daemon lost the lease with no ending was
 * lost with it. Each daemon publishes the processes it runs, so every
 * daemon on the store lists them, and the highest pid it handed out, so
 * a daemon that takes the lease next numbers past it and no pid repeats
 * in the workspace. A daemon that finds another's record left behind
 * stops the native runs it lists.
 *
 * Subclasses are infra adapters (RAM, Redis); everything above (job
 * numbers, waits, kills, hangups) is the table's, mirroring the
 * NamespaceStore design. Mirrors Python's `ExecutionStore`.
 */
export abstract class ExecutionStore {
  /**
   * @param leaseSeconds how long a lease lasts past its last renewal; null
   *   means it holds until released, which suits a store only one process
   *   reaches.
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

  /**
   * Drop one session's job list (the session closed) iff its generation
   * matches, so a job another daemon numbered after the list was read is
   * never dropped unstopped. True when the list is gone, false on
   * conflict.
   */
  abstract delete(sessionId: string, expectedGeneration: number): Promise<boolean>

  /**
   * The console stream a job list names. Every call for one name reaches
   * the same stream, so the job's daemon writes it and any other daemon
   * reads or ends it.
   */
  abstract console(name: string): ConsoleStore

  /**
   * Take the workspace's lease for a daemon, or keep it another
   * `leaseSeconds`, with the consoles of the jobs it runs. One call
   * compares and writes, so two daemons that ask at once never both hold
   * it. A store that expires consoles pushes their expiry out here, so a
   * quiet job keeps its output while its daemon holds the lease, and loses
   * it a while after the daemon dies with nobody left to end it. Answers
   * null when the daemon holds the lease now, else the id of the daemon
   * whose lease still holds.
   */
  abstract lease(daemon: string, consoles?: readonly string[]): Promise<string | null>

  /** The daemon whose lease holds, null when none does. */
  abstract holder(): Promise<string | null>

  /** Give the lease up, iff the daemon still holds it. */
  abstract release(daemon: string): Promise<void>

  /**
   * Replace the processes a daemon runs (PID to process); none drops its
   * record. The workspace's highest pid rises to `lastPid`, never falls. A
   * record outlives its daemon's lease, so a daemon that finds it left
   * behind still reads what it left running.
   */
  abstract publish(
    daemon: string,
    processes: Readonly<Record<string, RecordFields>>,
    lastPid?: number,
  ): Promise<void>

  /** Every daemon's published processes: daemon to PID to process. */
  abstract processes(): Promise<Record<string, Record<string, RecordFields>>>

  /** The highest pid any daemon published for the workspace, 0 before the first. */
  abstract highestPid(): Promise<number>

  /** Ask a daemon to stop one of its processes, by its PID, with `signal`. */
  abstract requestStop(daemon: string, pid: number, signal: number): Promise<void>

  /**
   * The stops asked of a daemon since it last took them, as [PID, signal]
   * pairs; taking them clears them.
   */
  abstract takeStops(daemon: string): Promise<[number, number][]>

  /** Delete every job list, console, lease and process record. */
  abstract clear(): Promise<void>

  /** Release any held connections. */
  abstract close(): Promise<void>
}
