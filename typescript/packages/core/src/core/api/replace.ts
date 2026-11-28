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

import { ApiError } from './errors.ts'

/**
 * A name beside `name` that no other writer picks. Drawn from the process
 * rather than the workspace's id source: the name lives in the service, where
 * a seeded one would meet an earlier run's leftover. Mirrors Python's
 * `aside_name`.
 */
export function asideName(name: string): string {
  return `${name}.mirage-${crypto.randomUUID().replaceAll('-', '')}`
}

// Whether the service refused the request, so nothing it asked for happened. A
// dropped connection, an abort, a 5xx or a check run after the request may
// each follow a change that went through.
function answered(err: unknown): boolean {
  return err instanceof ApiError && err.status !== null && err.status < 500
}

// An undo step, its failure logged, so the error that called for it stays
// the one thrown.
async function quietly(step: () => Promise<unknown>, what: string): Promise<void> {
  try {
    await step()
  } catch (err) {
    console.debug(`could not ${what}: ${String(err)}`)
  }
}

// Whether what a refused retire named is gone after all; a failed check
// counts as there.
async function goneAfterAll(gone: () => Promise<boolean>): Promise<boolean> {
  try {
    return await gone()
  } catch (err) {
    console.debug(`could not tell whether the retire went through: ${String(err)}`)
    return false
  }
}

/**
 * Move what holds a name aside, so an item can land on the name, answering
 * what `aside` answered. A refusal leaves it where it was; any other failure
 * may follow a move that went through, so `restore` puts it back. Mirrors
 * Python's `set_aside`.
 */
export async function setAside<T>(
  aside: () => Promise<T>,
  restore: () => Promise<unknown>,
): Promise<T> {
  try {
    return await aside()
  } catch (err) {
    if (!answered(err)) await quietly(restore, 'restore the destination')
    throw err
  }
}

/**
 * Land an item on a name, then retire what held the name before, answering
 * what `land` answered. What held it was set aside (`restore` puts it back)
 * or, on a service that keeps two items of one name, left beside the landing
 * (`restore` undefined). A failed landing restores it. A failed retire takes
 * the landing back and restores it, unless what it named is gone after all: a
 * delete whose answer was lost went through, so the replace stands. Mirrors
 * Python's `land_then_retire`.
 */
export async function landThenRetire<T>(
  land: () => Promise<T>,
  takeBack: (landed: T) => Promise<unknown>,
  retire: () => Promise<unknown>,
  gone: () => Promise<boolean>,
  restore?: () => Promise<unknown>,
): Promise<T> {
  let landed: T
  try {
    landed = await land()
  } catch (err) {
    if (restore !== undefined) await quietly(restore, 'restore the destination')
    throw err
  }
  try {
    await retire()
  } catch (err) {
    if (await goneAfterAll(gone)) return landed
    await quietly(() => takeBack(landed), 'take back the landing')
    if (restore !== undefined) await quietly(restore, 'restore the destination')
    throw err
  }
  return landed
}
