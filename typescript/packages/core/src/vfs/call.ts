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

// The functions whose TypeScript method name is not the name Python gives
// them: each answers to Python's name at the dispatcher, so a policy sees
// one name for it on both hosts.
const DISPATCH_NAMES: ReadonlyMap<string, string> = new Map([
  ['rmR', 'rm_r'],
  ['dirCopy', 'dir_copy'],
  ['duSize', 'du_size'],
  ['duEntries', 'du_entries'],
])
const METHOD_NAMES: ReadonlyMap<string, string> = new Map(
  [...DISPATCH_NAMES].map(([method, name]) => [name, method]),
)

/** The method that answers the dispatcher's `name`. */
export function methodName(name: string): string {
  return METHOD_NAMES.get(name) ?? name
}

// Removing, moving or copying a name is what these calls do, and the
// dispatcher's link, overlay and cache bookkeeping for it is keyed on their
// names.
const NAMED: Partial<Record<Effect, readonly string[]>> = {
  [Effect.REMOVE]: ['unlink', 'rmdir', 'rm_r'],
  [Effect.RENAME]: ['rename'],
  [Effect.COPY]: ['copy', 'dir_copy'],
}

interface Marked {
  [MARK]?: Declaration
}

/**
 * Make a VFS method callable by name through the dispatcher.
 *
 * `ws.dispatch('search_abc', path)` reaches a method marked here through
 * every check the dispatcher runs: hidden paths, path rules, the mount's mode and
 * admission policies. The effect tells the dispatcher what the call does to the
 * mount, so a read-only mount refuses a write and a policy judges it as one.
 * A subclass overriding a marked method keeps the mark, so a backend writes
 * its `read` without repeating it.
 *
 * The built-in functions' marks are where the dispatcher's op classes come from:
 * which ops follow a link, create a name, run one at a time per path or stamp
 * an mtime is read off what they declare here. REMOVE belongs to `unlink`,
 * `rmdir` and `rm_r`, RENAME to `rename` and COPY to `copy` and `dir_copy`:
 * what the dispatcher does around them (a link removed rather than followed, a
 * rename refused when it would bring hidden entries into view, the links and
 * cache below a moved, removed or copied directory) is keyed on those names,
 * so another function declaring one is refused. A VFS that deletes, moves or
 * copies defines those functions. `target` is the kind of entry the path names
 * (any when omitted), `creates` marks a WRITE that makes a missing file, as
 * open(2) with O_CREAT, and `subtree` a call that reaches everything below its
 * paths. Mirrors Python's `vfs_call`.
 */
export function vfsCall(options: {
  effect: Effect
  target?: Target
  creates?: boolean
  subtree?: boolean
}) {
  const mark: Declaration = {
    effect: options.effect,
    target: options.target ?? Target.ANY,
    creates: options.creates ?? false,
    subtree: options.subtree ?? false,
  }
  return function apply(
    method: (...args: never[]) => unknown,
    context: ClassMethodDecoratorContext,
  ): void {
    const name = DISPATCH_NAMES.get(String(context.name)) ?? String(context.name)
    const names = NAMED[mark.effect] ?? [name]
    if (!names.includes(name)) {
      throw new TypeError(
        `${name}: only ${names.join(', ')} may declare ${mark.effect.toUpperCase()}`,
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
  const method = methodName(name)
  let proto: unknown = cls.prototype
  while (typeof proto === 'object' && proto !== null) {
    const fn: unknown = Object.getOwnPropertyDescriptor(proto, method)?.value
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
  const dispatched = [...names].map((name) => DISPATCH_NAMES.get(name) ?? name)
  for (const name of dispatched.sort(compareCodePoints)) {
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
