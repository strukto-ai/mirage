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

import { RETRIED_ANSWERS } from './constants.ts'
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
// each follow a change that went through, and so may a 404: a client that
// retries a 503 answers with what the retry met, after its first attempt moved
// the item.
function answered(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status !== null &&
    err.status < 500 &&
    !RETRIED_ANSWERS.has(err.status)
  )
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

// Ask the service what a step whose answer was lost did, null when the
// question fails too.
async function asked<V>(check: () => Promise<V>, what: string): Promise<V | null> {
  try {
    return await check()
  } catch (err) {
    console.debug(`could not tell whether ${what}: ${String(err)}`)
    return null
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

// Settle a landing that threw, answering the landing to finish, null once
// what was set aside is put back. One whose answer was lost may have gone
// through, and then holds the name, where `restore` cannot put anything
// back: `arrived` finds it. Mirrors Python's `_landing_failed`, which also
// takes a landing back under a cancellation.
async function landingFailed<T>(
  err: unknown,
  restore: (() => Promise<unknown>) | undefined,
  arrived: (() => Promise<T | null>) | undefined,
): Promise<T | null> {
  if (arrived !== undefined && !answered(err)) {
    const found = await asked(arrived, 'the landing went through')
    if (found !== null) return found
  }
  if (restore !== undefined) await quietly(restore, 'restore the destination')
  return null
}

// Settle a retire that threw, answering whether it went through after all.
// It is undone only while what it named is still there: a delete whose
// answer was lost may have gone through, so a failed check keeps the
// landing, since undoing it then would leave nothing at the name. Mirrors
// Python's `_retire_failed`.
async function retireFailed<T>(
  landed: T,
  takeBack: (landed: T) => Promise<unknown>,
  gone: () => Promise<boolean>,
  restore: (() => Promise<unknown>) | undefined,
): Promise<boolean> {
  const went = await asked(gone, 'the retire went through')
  if (went !== false) return went === true
  await quietly(() => takeBack(landed), 'take back the landing')
  if (restore !== undefined) await quietly(restore, 'restore the destination')
  return false
}

/**
 * Land an item on a name, then retire what held the name before, answering
 * what `land` answered or what `arrived` found. What held it was set aside
 * (`restore` puts it back) or, on a service that keeps two items of one name,
 * left beside the landing (`restore` undefined). A refused landing restores
 * it; one whose answer was lost but which went through (`arrived`, null when
 * it did not or the service cannot tell it from another writer's) is
 * finished. A failed retire takes the landing back, held to the version it
 * landed as, and restores it, unless what it named is gone after all or that
 * cannot be told: the replace then stands. Mirrors Python's
 * `land_then_retire`.
 */
export async function landThenRetire<T>(
  land: () => Promise<T>,
  takeBack: (landed: T) => Promise<unknown>,
  retire: () => Promise<unknown>,
  gone: () => Promise<boolean>,
  restore?: () => Promise<unknown>,
  arrived?: () => Promise<T | null>,
): Promise<T> {
  let landed: T
  try {
    landed = await land()
  } catch (err) {
    const found = await landingFailed(err, restore, arrived)
    if (found === null) throw err
    console.debug(`the landing went through after all: ${String(err)}`)
    landed = found
  }
  try {
    await retire()
  } catch (err) {
    if (await retireFailed(landed, takeBack, gone, restore)) return landed
    throw err
  }
  return landed
}
