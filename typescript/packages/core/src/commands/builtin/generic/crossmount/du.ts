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

import { DISPATCH_BUILDERS } from './constants.ts'
import { mountStarts, reached } from './scopes.ts'
import type { CrossResult, RunSingle } from './types.ts'
import { du, parseFlags } from '../du.ts'
import { runDispatch } from '../../generic_bind/dispatch.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { FlagValue } from '../../../spec/types.ts'
import { boundedMap } from '../../../../concurrency/limiter.ts'
import { IOResult, materialize, type ByteSource, type SizedRun } from '../../../../io/types.ts'
import type { NamespaceView } from '../../../../view/types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { PathSpec } from '../../../../types.ts'
import { stripSlash } from '../../../../utils/slash.ts'

// The flags that shape only the rendering: every mount measures without them,
// and the line renders once.
export const RENDERING: ReadonlySet<string> = new Set(['s', 'max_depth'])

/**
 * Render du over operands spanning mounts from each mount's own du.
 *
 * Every start point is measured by the du its mount registered, a few at a
 * time, and the measurements (`IOResult.sizedRuns`) render as one tree: a
 * directory's row counts the mounts inside it, and `-c` totals the line. No
 * mount's output text is read back. A mount whose du fails adds its
 * diagnostic and status, and the mounts below it count only where the walk
 * could still reach them (`reached`); one that succeeds without a measurement
 * (a du not built on `duGeneric`) leaves the line to the one dispatcher walk.
 * With `nested`, `runSingle` answers only its own mount's part, so the mounts
 * below each operand are measured here unless `-x` keeps the walk on one
 * filesystem; otherwise each operand's run composes its own.
 */
export async function runDu(
  paths: readonly PathSpec[],
  texts: readonly string[],
  bag: Record<string, FlagValue>,
  dispatch: DispatchFn,
  runSingle: RunSingle,
  cwd: string,
  ns?: NamespaceView,
  stdin: ByteSource | null = null,
  signal?: AbortSignal,
  nested = false,
): Promise<CrossResult> {
  const rendering = parseFlags({ stdin: null, flags: bag, cwd })
  const bounded = new FlagView(bag, specOf('du')).asBool('one_file_system')
  const measuring = Object.fromEntries(Object.entries(bag).filter(([k]) => !RENDERING.has(k)))
  // Each start is then one mount's own part, and keeps only what that mount
  // owns: a part walked through the dispatcher reaches the mounts below it
  // too, which measure themselves.
  const mounts = nested && !bounded ? ns?.mounts : undefined
  const plan: [number, PathSpec][] = paths.flatMap((path, index) =>
    (mounts !== undefined ? mountStarts(path, ns) : [path]).map((start): [number, PathSpec] => [
      index,
      start,
    ]),
  )
  const ios = await boundedMap(
    plan,
    async ([, start]) => {
      const [out, io] = await runSingle(
        'du',
        [start],
        [...texts],
        measuring,
        signal === undefined ? {} : { signal },
      )
      await materialize(out)
      return io
    },
    4,
  )
  // A run that failed measured nothing and says why; one that succeeded
  // without a measurement is a du this line cannot compose.
  if (ios.some((io) => io.sizedRuns === null && io.exitCode === 0)) {
    const builder = DISPATCH_BUILDERS.get('du')
    if (builder === undefined) throw new Error('No dispatch builder for du')
    return runDispatch(builder, paths, texts, bag, dispatch, cwd, ns, stdin, signal)
  }
  const kept = await reached(
    paths,
    plan,
    ios.map((io) => io.exitCode !== 0),
    dispatch,
  )
  const done = plan.flatMap((step, i) => {
    const io = ios[i]
    return kept[i] === true && io !== undefined ? [{ step, io }] : []
  })
  const leaves: (readonly [string, number])[][] = paths.map(() => [])
  const below: string[][] = paths.map(() => [])
  const present = paths.map(() => false)
  let merged = new IOResult()
  for (const { step, io } of done) {
    const [index, start] = step
    const owner = mounts?.rootOf(start.virtual)
    const owned = (virtual: string): boolean =>
      mounts === undefined || mounts.rootOf(virtual) === owner
    const found = (io.sizedRuns ?? []).flatMap((run) => run.leaves.filter(([leaf]) => owned(leaf)))
    if (start === paths[index]) {
      present[index] = (io.sizedRuns ?? []).length > 0
    } else if (found.every(([leaf]) => stripSlash(leaf) !== stripSlash(start.virtual))) {
      // A mount root holding nothing still gets its row, unless the mount
      // is one file (/.bash_history).
      below[index]?.push(start.virtual)
    }
    leaves[index]?.push(...found)
    for (const run of io.sizedRuns ?? []) below[index]?.push(...run.directories.filter(owned))
    merged = await merged.merge(io)
  }
  const measured = new Map<PathSpec, [(readonly [string, number])[], string[]]>()
  paths.forEach((path, index) => {
    if (!present[index]) return
    const target = new PathSpec({
      virtual: path.virtual,
      directory: path.directory,
      vfsPath: stripSlash(path.virtual),
      pattern: path.pattern,
      resolved: path.resolved,
      rawPath: path.rawPath,
      dotted: path.dotted,
      walkError: path.walkError,
    })
    measured.set(target, [leaves[index] ?? [], below[index] ?? []])
  })
  const entries = (path: PathSpec): Promise<[[string, number][], number]> => {
    const found = (measured.get(path)?.[0] ?? []).map(([leaf, size]): [string, number] => [
      leaf,
      size,
    ])
    return Promise.resolve([found, found.reduce((acc, [, size]) => acc + size, 0)])
  }
  const out = await du(
    [...measured.keys()],
    rendering,
    async (path) => (await entries(path))[1],
    entries,
    [],
    undefined,
    null,
    null,
    undefined,
    () => [...measured.values()].flatMap(([, dirs]) => dirs),
    ns,
  )
  merged.stderr = new Uint8Array([...out.stderr, ...(await materialize(merged.stderr))])
  merged.exitCode = Math.max(out.exitCode, ...done.map(({ io }) => io.exitCode))
  merged.sizedRuns = [...measured.values()].map(([found, dirs]): SizedRun => ({
    leaves: found,
    directories: dirs,
  }))
  return [out.stdout, merged]
}
