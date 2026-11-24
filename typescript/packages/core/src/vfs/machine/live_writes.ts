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

import type { MachineAccessor } from '../../accessor/machine.ts'
import { holders } from '../../core/machine/place.ts'
import type { Landing } from '../../core/machine/types.ts'
import { unlink as machineUnlink } from '../../core/machine/unlink.ts'
import { isMissingPath } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'

/**
 * The key a removal of a name on a machine is under while it runs. Mirrors
 * Python's `_removal_slot`.
 *
 * @param path the name.
 * @param machine the machine.
 */
function removalSlot(path: PathSpec, machine: string): string {
  return `${machine}\0${path.virtual}`
}

/**
 * Take an older copy of a name off a machine; one already gone is no error.
 * Mirrors Python's `_unlink_older`.
 *
 * @param accessor the mount's machines.
 * @param machine the machine holding the copy.
 * @param path the name.
 */
async function unlinkOlder(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
): Promise<void> {
  try {
    await machineUnlink(accessor, machine, path)
  } catch (err) {
    if (!isMissingPath(err)) throw err
    console.debug(`${path.virtual} already gone from ${machine}:`, err)
  }
}

/**
 * The writes landing on a machine mount's names, kept so that once the
 * writes of a name end, one copy of it shows, the newest. A write is live
 * from before it chooses its machine until it ends (`landing`). One that
 * replaces a name settles it: every other machine's copy goes (`settle`). A
 * write live meanwhile leaves the name unsettled, and the last write of the
 * name to end settles it again, a failed one too. No copy goes while a write
 * still chooses its machine, nor the copy of a machine a live write chose,
 * and a write whose machine's copy is being removed chooses again, so a
 * write never builds on a copy that is going. Mirrors Python's `LiveWrites`.
 */
export class LiveWrites {
  private readonly live = new Map<string, (string | null)[]>()
  private readonly latest = new Map<string, readonly [number, string]>()
  private landings = 0
  private readonly settling = new Map<string, number>()
  private readonly unsettled = new Set<string>()
  private readonly removing = new Map<string, Promise<void>>()

  /** @param accessor the mount's machines. */
  constructor(private readonly accessor: MachineAccessor) {}

  /**
   * Count a write of a name as live from before it chooses its machine until
   * it ends (`end`). While it chooses, a settling takes no copy of the name
   * away, since the write may land on any, and leaves the name for the write
   * to settle; a write that begins while the name settles leaves it unsettled
   * at once. A write whose machine's copy is being removed waits for the
   * removal and chooses again, so it neither builds on a copy that is going
   * nor has the removal take its bytes.
   *
   * @param path the name.
   * @param choose where the write lands; one whose bytes come from that
   *   machine (`Landing.origin`) replaces the name, so once it lands no other
   *   machine's copy of it stays.
   * @param write the write, where it lands.
   */
  async landing<T>(
    path: PathSpec,
    choose: () => Promise<Landing>,
    write: (landed: Landing) => Promise<T>,
  ): Promise<T> {
    const key = path.virtual
    let live = this.live.get(key)
    if (live === undefined) {
      live = []
      this.live.set(key, live)
    }
    live.push(null)
    if (this.settling.has(key)) this.unsettled.add(key)
    let machine: string | null = null
    let landed: Landing
    let done: T
    try {
      landed = await choose()
      for (
        let gone = this.removing.get(removalSlot(path, landed.machine));
        gone !== undefined;
        gone = this.removing.get(removalSlot(path, landed.machine))
      ) {
        await gone.catch(() => undefined)
        landed = await choose()
      }
      machine = landed.machine
      live[live.indexOf(null)] = machine
      done = await write(landed)
    } catch (err) {
      await this.end(machine, path, false, false)
      throw err
    }
    await this.end(machine, path, true, landed.origin)
    return done
  }

  /**
   * End a live write of a name. One that landed is the name's latest copy,
   * noted while the name has other writes to settle with (`latest`). One that
   * replaces the name settles it, and so does the last write of an unsettled
   * name to end.
   *
   * @param machine the machine written; null for a write that ended before
   *   choosing one.
   * @param path the name.
   * @param landed the write landed; a failed one leaves the copies of those
   *   that did.
   * @param replaces the write replaces the name.
   */
  private async end(
    machine: string | null,
    path: PathSpec,
    landed: boolean,
    replaces: boolean,
  ): Promise<void> {
    const key = path.virtual
    const live = this.live.get(key) ?? []
    live.splice(live.indexOf(machine), 1)
    if (live.length === 0) this.live.delete(key)
    const busy = live.length > 0 || this.unsettled.has(key) || this.settling.has(key)
    if (landed && machine !== null && (replaces || busy)) {
      this.landings += 1
      this.latest.set(key, [this.landings, machine])
    }
    const lastOfUnsettled = live.length === 0 && this.unsettled.has(key)
    if (!(landed && replaces) && !lastOfUnsettled) {
      this.forget(key)
      return
    }
    if (lastOfUnsettled) this.unsettled.delete(key)
    try {
      await this.settle(path)
    } catch (err) {
      if (landed) throw err
      console.debug(`older copies of ${key} kept:`, err)
    }
  }

  /**
   * Take a name off every machine but the one its latest write landed on
   * (`latest`), so one copy shows, the newest. The latest is looked up again
   * before every removal, and a write landing meanwhile makes the look start
   * over with its copy kept. A write live as the look starts, on another
   * machine or still choosing one, leaves the name unsettled, as one beginning
   * meanwhile does (`landing`), for the last write of it to settle (`end`). A
   * machine a live write chose keeps its copy, found or not yet made, and no
   * copy goes while a write still chooses its machine.
   *
   * @param path the name.
   */
  private async settle(path: PathSpec): Promise<void> {
    const key = path.virtual
    this.settling.set(key, (this.settling.get(key) ?? 0) + 1)
    try {
      for (
        let seen = this.latest.get(key);
        this.accessor.several && seen !== undefined;
        seen = this.latest.get(key)
      ) {
        const kept = seen[1]
        if (this.live.get(key)?.some((machine) => machine !== kept) === true)
          this.unsettled.add(key)
        for (const one of await holders(this.accessor, path)) {
          if (this.latest.get(key) !== seen) break
          const live = this.live.get(key) ?? []
          if (
            one.machine === kept ||
            one.isFolder ||
            live.includes(one.machine) ||
            live.includes(null)
          )
            continue
          await this.removeCopy(one.machine, path)
        }
        if (this.latest.get(key) === seen) return
      }
    } finally {
      const left = (this.settling.get(key) ?? 1) - 1
      if (left > 0) this.settling.set(key, left)
      else this.settling.delete(key)
      this.forget(key)
    }
  }

  /**
   * Take an older copy of a name off a machine, once: a settling that finds
   * the removal under way waits for it and shares its outcome, a failure too,
   * and a write of the name there waits until it is gone (`landing`).
   *
   * @param machine the machine holding the copy.
   * @param path the name.
   */
  private async removeCopy(machine: string, path: PathSpec): Promise<void> {
    const slot = removalSlot(path, machine)
    let removal = this.removing.get(slot)
    if (removal === undefined) {
      removal = unlinkOlder(this.accessor, machine, path).finally(() => {
        this.removing.delete(slot)
      })
      this.removing.set(slot, removal)
    }
    await removal
  }

  /**
   * Let go of a name's latest landing once nothing writes or settles it.
   *
   * @param key the name.
   */
  private forget(key: string): void {
    if (!this.live.has(key) && !this.unsettled.has(key) && !this.settling.has(key))
      this.latest.delete(key)
  }
}
