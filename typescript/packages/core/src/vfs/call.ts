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

import { compareCodePoints } from '../utils/sort.ts'
import { type Declaration, Effect, Target } from './types.ts'

const MARK = Symbol.for('mirage.vfsCall')

// Removing or moving a name is what these calls do, and the door's link,
// overlay and cache bookkeeping for it is keyed on their names.
const NAMED: Partial<Record<Effect, readonly string[]>> = {
  [Effect.REMOVE]: ['unlink', 'rmdir'],
  [Effect.RENAME]: ['rename'],
}

interface Marked {
  [MARK]?: Declaration
}

/**
 * Make a VFS method callable by name through the dispatcher.
 *
 * `ws.dispatch('search_abc', path)` reaches a method marked here through
 * every check the door runs: hidden paths, path rules, the mount's mode and
 * admission policies. The effect tells the door what the call does to the
 * mount, so a read-only mount refuses a write and a policy judges it as one.
 * A subclass overriding a marked method keeps the mark, so a backend writes
 * its `read` without repeating it.
 *
 * The built-in functions' marks are where the door's op classes come from:
 * which ops follow a link, create a name, run one at a time per path or stamp
 * an mtime is read off what they declare here. REMOVE belongs to `unlink` and
 * `rmdir` and RENAME to `rename`: what the door does around them (a link
 * removed rather than followed, a rename refused when it would bring hidden
 * entries into view, the links and cache below a moved directory) is keyed on
 * those names, so another function declaring either is refused. A VFS that deletes or moves defines those functions. `target` is the
 * kind of entry the
 * path names (any when omitted) and `creates` marks a WRITE that makes a
 * missing file, as open(2) with O_CREAT. Mirrors Python's `vfs_call`.
 */
export function vfsCall(options: { effect: Effect; target?: Target; creates?: boolean }) {
  const mark: Declaration = {
    effect: options.effect,
    target: options.target ?? Target.ANY,
    creates: options.creates ?? false,
  }
  return function apply(
    method: (...args: never[]) => unknown,
    context: ClassMethodDecoratorContext,
  ): void {
    const name = String(context.name)
    const names = NAMED[mark.effect] ?? [name]
    if (!names.includes(name)) {
      throw new TypeError(
        `${name}: only ${names.join(' and ')} may declare ${mark.effect.toUpperCase()}`,
      )
    }
    ;(method as Marked)[MARK] = mark
  }
}

/**
 * What `cls` declares for `name`, null when not dispatchable. The first class
 * up the prototype chain that marks `name` answers, so an unmarked override
 * inherits its base's mark. Mirrors Python's `declared`.
 */
export function declared(cls: { readonly prototype: unknown }, name: string): Declaration | null {
  let proto: unknown = cls.prototype
  while (typeof proto === 'object' && proto !== null) {
    const fn: unknown = Object.getOwnPropertyDescriptor(proto, name)?.value
    const mark = typeof fn === 'function' ? (fn as Marked)[MARK] : undefined
    if (mark !== undefined) return mark
    proto = Object.getPrototypeOf(proto)
  }
  return null
}

/** Every name `cls` marks dispatchable, to what it declares. Mirrors Python's `declared_calls`. */
export function declaredCalls(cls: { readonly prototype: unknown }): Map<string, Declaration> {
  const names = new Set<string>()
  let proto: unknown = cls.prototype
  while (typeof proto === 'object' && proto !== null) {
    for (const name of Object.getOwnPropertyNames(proto)) names.add(name)
    proto = Object.getPrototypeOf(proto)
  }
  const calls = new Map<string, Declaration>()
  for (const name of [...names].sort(compareCodePoints)) {
    const mark = declared(cls, name)
    if (mark !== null) calls.set(name, mark)
  }
  return calls
}

/**
 * The names in `calls` whose declaration matches every filter: the effects
 * and targets to keep (all when omitted), and `creates` to keep only
 * creating (true) or only non-creating (false) calls. Mirrors Python's
 * `call_names`.
 */
export function callNames(
  calls: ReadonlyMap<string, Declaration>,
  filter: {
    effects?: readonly Effect[]
    targets?: readonly Target[]
    creates?: boolean
  } = {},
): ReadonlySet<string> {
  const names = new Set<string>()
  for (const [name, mark] of calls) {
    if (filter.effects !== undefined && !filter.effects.includes(mark.effect)) continue
    if (filter.targets !== undefined && !filter.targets.includes(mark.target)) continue
    if (filter.creates !== undefined && mark.creates !== filter.creates) continue
    names.add(name)
  }
  return names
}
