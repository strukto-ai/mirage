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

import { FileStat, FileType, PathSpec } from '../types.ts'
import { isMissingPath } from './errors.ts'

export type Allowed = (virtual: string) => boolean

/**
 * A remnant cascade met an entry the session can see.
 *
 * Thrown by `removeRemnants` before the visible entry is touched: the
 * caller's not-empty refusal is then simply true in the session's own
 * view, so every arm answers this by re-raising that original refusal
 * rather than deleting visible data.
 */
export class VisibleRemnant extends Error {
  readonly code = 'ENOTEMPTY'
  readonly virtual: string

  constructor(virtual: string) {
    super(`ENOTEMPTY: directory not empty, '${virtual}'`)
    this.name = 'VisibleRemnant'
    this.virtual = virtual
  }
}

/**
 * The four ops a remnant cascade speaks, on one plane's own protected
 * channel.
 *
 * The channel carries every protection axis except visibility: a
 * deletion must still answer for its path's mode and rules exactly as
 * a first-class op would (the command plane binds its mode- and
 * rule-guarded slots, the dispatcher routes through its own fenced op
 * door), while the visibility filter stays off because the cascade
 * exists to see and destroy what the session cannot. The cascade never
 * sprinkles those checks itself; wiring a raw, unguarded channel here
 * is the bug this contract exists to prevent.
 */
export interface RemnantChannel {
  readdir(spec: PathSpec): Promise<string[]>
  stat(spec: PathSpec): Promise<unknown>
  unlink(spec: PathSpec): Promise<void>
  rmdir(spec: PathSpec): Promise<void>
}

/**
 * One listing entry's bare child name. Cold object-store listings mark
 * a directory with a trailing slash, and some backends report whole
 * paths rather than names; both normalize to the last component.
 */
export function entryName(entry: string): string {
  const trimmed = entry.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/**
 * Whether any listed name is visible as a child of `base`.
 *
 * The one emptiness predicate every remnant arm judges with, fed every
 * name source its plane can enumerate (the backend listing, and on the
 * ops plane the namespace's merged children too), so "visibly empty"
 * cannot mean different things at different doors.
 */
export function visibleBelow(base: string, names: Iterable<string>, allowed: Allowed): boolean {
  const root = base.replace(/\/+$/, '')
  for (const name of names) {
    if (allowed(`${root}/${entryName(name)}`)) return true
  }
  return false
}

/** The child PathSpec one cascade step descends to. */
export function childSpec(spec: PathSpec, name: string): PathSpec {
  const base = spec.virtual.replace(/\/+$/, '')
  const key = spec.vfsPath.replace(/\/+$/, '')
  return new PathSpec({
    virtual: `${base}/${name}`,
    directory: spec.virtual,
    vfsPath: key === '' ? name : `${key}/${name}`,
  })
}

/**
 * Remove one directory and everything under it, children first,
 * revalidating visibility at every step.
 *
 * The walk lists raw, but the moment any entry is visible the whole
 * cascade aborts with `VisibleRemnant` before that entry is touched:
 * between the caller's classification and each deletion another writer
 * may have created something visible, and destroying it would turn an
 * ostensibly empty rmdir into data loss. An entry that vanishes
 * mid-walk is a completed removal (a prefix-store directory disappears
 * with its last child), not an error. Every op goes through the
 * channel, so the plane's other protections refuse exactly as they
 * would a first-class op; the caller answers any cascade failure with
 * its original refusal.
 */
export async function removeRemnants(
  channel: RemnantChannel,
  allowed: Allowed,
  spec: PathSpec,
): Promise<void> {
  let entries: string[]
  try {
    entries = await channel.readdir(spec)
  } catch (err) {
    if (isMissingPath(err)) return
    throw err
  }
  for (const entry of entries) {
    const name = entryName(entry)
    const child = childSpec(spec, name)
    if (allowed(child.virtual)) throw new VisibleRemnant(child.virtual)
    let row: unknown
    try {
      row = await channel.stat(child)
    } catch (err) {
      if (isMissingPath(err)) continue
      throw err
    }
    if (row instanceof FileStat && row.type === FileType.DIRECTORY) {
      await removeRemnants(channel, allowed, child)
    } else {
      try {
        await channel.unlink(child)
      } catch (err) {
        if (!isMissingPath(err)) throw err
      }
    }
  }
  try {
    await channel.rmdir(spec)
  } catch (err) {
    if (!isMissingPath(err)) throw err
  }
}
