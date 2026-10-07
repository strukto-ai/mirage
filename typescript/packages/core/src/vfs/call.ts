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

import type { Effect } from './types.ts'

const EFFECT = Symbol.for('mirage.vfsCall')

interface Marked {
  [EFFECT]?: Effect
}

/**
 * Make a VFS method callable by name through the dispatcher.
 *
 * `ws.dispatch('search_abc', path)` reaches a method marked here through
 * every check the door runs: hidden paths, path rules, the mount's mode and
 * admission policies. The effect tells the door what the call does to the
 * mount, so a read-only mount refuses a write and a policy judges it as one.
 * A subclass overriding a marked method keeps the mark, so a backend writes
 * its `read` without repeating it. Mirrors Python's `vfs_call`.
 */
export function vfsCall(options: { effect: Effect }) {
  return function mark(
    method: (...args: never[]) => unknown,
    _context: ClassMethodDecoratorContext,
  ): void {
    ;(method as Marked)[EFFECT] = options.effect
  }
}

/**
 * The effect `cls` declares for `name`, null when not dispatchable. The
 * first class up the prototype chain that marks `name` answers, so an
 * unmarked override inherits its base's mark. Mirrors Python's
 * `call_effect`.
 */
export function callEffect(cls: { prototype: object }, name: string): Effect | null {
  let proto: object | null = cls.prototype
  while (proto !== null) {
    const fn: unknown = Object.getOwnPropertyDescriptor(proto, name)?.value
    const effect = typeof fn === 'function' ? (fn as Marked)[EFFECT] : undefined
    if (effect !== undefined) return effect
    proto = Object.getPrototypeOf(proto) as object | null
  }
  return null
}
