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

import { ShellArray } from '../shell/array.ts'
import {
  attrLetters,
  attrsFromLetters,
  type ManagedRef,
  type ShellValue,
  type ShellVar,
} from '../shell/variable.ts'
import { SystemIdSource } from '../utils/ids.ts'
import { type RawValue, Shell, type ShellRecord } from './shell.ts'

/** The record mirage-rs holds as a `ShellVar`. Mirrors Python's var_of. */
export function varOf(record: ShellRecord): ShellVar {
  const [raw, cluster, managed] = record
  let value: ShellValue | null = null
  if (typeof raw === 'string') value = raw
  else if (raw !== null && cluster.startsWith('A')) {
    value = Object.fromEntries(raw as ReadonlyMap<string, string>)
  } else if (raw !== null) value = new ShellArray(raw as ReadonlyMap<bigint, string>)
  const out: ShellVar = { value, attrs: attrsFromLetters(cluster) }
  if (managed === null) return out
  const [source, ref, key, eager] = managed
  return { ...out, managed: { source, ref, key, eager } satisfies ManagedRef }
}

/** A `ShellVar` as the record mirage-rs holds. Mirrors Python's record_of. */
export function recordOf(v: ShellVar): ShellRecord {
  const ref = v.managed
  return [
    rawValue(v.value)[0],
    attrLetters(v),
    ref === undefined ? null : [ref.source, ref.ref, ref.key, ref.eager],
  ]
}

/** A value as mirage-rs takes it, and whether it is associative. Mirrors Python's raw_value. */
export function rawValue(value: ShellValue | null): [RawValue, boolean] {
  if (value === null || typeof value === 'string') return [value, false]
  if (value instanceof ShellArray) return [value.elements, false]
  return [new Map(Object.entries(value)), true]
}

/**
 * A session's variables, held by its mirage-rs `Shell`. The records read
 * and write as `ShellVar`; a write here is shell bookkeeping, never a
 * line's, which runs through the shell's gated writes. Mirrors Python's
 * ShellVars.
 */
export class ShellVars {
  constructor(public shell: Shell) {}

  /**
   * A new shell holding `table`; `ids` is where a fresh `$RANDOM` seeds,
   * the platform's randomness until a session binds its own source.
   */
  static of(
    table: Iterable<readonly [string, ShellVar]> | Readonly<Record<string, ShellVar>>,
    ids: (() => number) | null = null,
  ): ShellVars {
    const system = new SystemIdSource()
    const out = new ShellVars(Shell.create(ids ?? (() => system.randomU32())))
    const entries = Symbol.iterator in table ? table : Object.entries(table)
    for (const [name, v] of entries) {
      out.shell.place(name, recordOf(v))
    }
    return out
  }

  get(name: string): ShellVar | undefined {
    const record = this.shell.get(name)
    return record === null ? undefined : varOf(record)
  }

  set(name: string, v: ShellVar): void {
    this.shell.place(name, recordOf(v))
  }

  /** Drop a name's record; the one it held, undefined for none. */
  delete(name: string): ShellVar | undefined {
    const old = this.shell.place(name, null)
    return old === null ? undefined : varOf(old)
  }

  has(name: string): boolean {
    return this.shell.has(name)
  }

  names(): string[] {
    return this.shell.names()
  }

  get size(): number {
    return this.shell.size
  }

  /** Every record, in no order, in one call. */
  records(): [string, ShellVar][] {
    return this.shell.records().map(([name, record]) => [name, varOf(record)])
  }

  /** A copy for a fork of the session. */
  fork(): ShellVars {
    return new ShellVars(this.shell.fork())
  }

  /** A child shell's copy: the scopes too, `$RANDOM` anew. */
  subshell(): ShellVars {
    return new ShellVars(this.shell.subshell())
  }
}
