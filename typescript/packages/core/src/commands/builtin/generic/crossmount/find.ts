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

import {
  EXEC_BATCH_END,
  EXEC_END,
  FIND_EXEC_PREDICATES,
  FIND_VALUE_PREDICATES,
} from '../../constants.ts'
import { parseFindExpression } from '../../find_parse.ts'
import { DISPATCH_BUILDERS } from './constants.ts'
import { mountStarts, reached } from './scopes.ts'
import type { CrossResult, RunSingle } from './types.ts'
import { runDispatch } from '../../generic_bind/dispatch.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { FlagValue } from '../../../spec/types.ts'
import { boundedMap } from '../../../../concurrency/limiter.ts'
import { IOResult, materialize, type ByteSource } from '../../../../io/types.ts'
import type { NamespaceView } from '../../../../view/types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { PathSpec } from '../../../../types.ts'
import { respellOne } from '../../../../utils/path.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'

// The tests whose verdict on one entry decides what the walk reads below it,
// or that read a listing a mount boundary splits: no mount's own find can
// answer them for the whole tree, so such a line keeps the one walk.
export const WALK_WIDE: ReadonlySet<string> = new Set(['-prune', '-empty', '-xdev', '-mount'])

/** Each word of a find expression that is not another word's argument. */
export function predicates(texts: readonly string[]): [number, string][] {
  const found: [number, string][] = []
  for (let i = 0; i < texts.length; i++) {
    const word = texts[i] ?? ''
    found.push([i, word])
    if (FIND_VALUE_PREDICATES.has(word)) {
      i += 1
    } else if (FIND_EXEC_PREDICATES.has(word)) {
      i += 1
      while (
        i < texts.length &&
        !(texts[i] === EXEC_END || (texts[i] === EXEC_BATCH_END && texts[i - 1] === '{}'))
      )
        i += 1
    }
  }
  return found
}

/**
 * The expression for a start point `depth` levels below the operand.
 *
 * Its depth limits count from that start point; `alone` matches the start
 * point only, not what lies below. Null when the limits leave it nothing to
 * print.
 */
export function shifted(
  texts: readonly string[],
  bag: Record<string, FlagValue>,
  depth: number,
  maxDepth: number | null,
  minDepth: number | null,
  alone = false,
): [string[], Record<string, FlagValue>] | null {
  if (maxDepth !== null && depth > maxDepth) return null
  if (alone && minDepth !== null && depth < minDepth) return null
  const top = alone ? 0 : maxDepth === null ? null : maxDepth - depth
  const bottom = minDepth === null ? null : Math.max(0, minDepth - depth)
  const limits = new Map([
    ['-maxdepth', top],
    ['-mindepth', bottom],
  ])
  let words = [...texts]
  const limited: Record<string, FlagValue> = { ...bag }
  for (const [i, word] of predicates(texts)) {
    const limit = limits.get(word) ?? null
    if (limit !== null) {
      words[i + 1] = String(limit)
      limited[word.slice(1)] = String(limit)
    }
  }
  if (alone && !('maxdepth' in limited)) {
    words = ['-maxdepth', '0', ...words]
    limited.maxdepth = '0'
  }
  return [words, limited]
}

/**
 * The directories between an operand and the mounts below it.
 *
 * No mount's own find can answer for them: the parent's backend may hold none
 * of them (a mount at `/usr/bin` implies `/usr`), so each is matched alone,
 * through the dispatcher.
 */
export function joints(path: PathSpec, starts: readonly PathSpec[]): PathSpec[] {
  const base = path.virtual.replace(/\/+$/, '')
  const roots = new Set(starts.slice(1).map((s) => s.virtual))
  const between = new Set<string>()
  for (const root of roots) {
    const parts = root
      .slice(base.length)
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .slice(0, -1)
    for (let end = 1; end <= parts.length; end++) {
      between.add(`${base}/${parts.slice(0, end).join('/')}`)
    }
  }
  return [...between]
    .filter((virtual) => !roots.has(virtual))
    .sort(compareCodePoints)
    .map(
      (virtual) =>
        new PathSpec({
          virtual,
          directory: virtual,
          vfsPath: virtual.replace(/^\/+|\/+$/g, ''),
          rawPath: respellOne(virtual, path.virtual, path.rawPath),
        }),
    )
}

/**
 * Compose find over operands holding mounts from each mount's own find.
 *
 * Every operand, and every visible mount below it, runs the find its mount
 * registered, a few at a time, with the depth limits counted from its own
 * start point; the directories between them (`joints`) are matched once each
 * through the dispatcher. Each run answers for the rows its mount owns (the
 * parent's shadowed keys stay out), and the rows merge in the walk's path
 * order, so the actions still run once over every mount's `matchedRuns`; a
 * mount whose find fails adds its diagnostic and status, as GNU's walk past
 * an unreadable directory does, and the mounts below it count only where the
 * walk could still reach them (`reached`). An expression that looks across a
 * boundary (`WALK_WIDE`, `-L`), or a find that succeeds without structured
 * rows, keeps the one dispatcher walk.
 */
export async function runFind(
  paths: readonly PathSpec[],
  texts: readonly string[],
  bag: Record<string, FlagValue>,
  dispatch: DispatchFn,
  runSingle: RunSingle,
  cwd: string,
  ns?: NamespaceView,
  stdin: ByteSource | null = null,
  signal?: AbortSignal,
): Promise<CrossResult> {
  const builder = DISPATCH_BUILDERS.get('find')
  if (builder === undefined) throw new Error('No dispatch builder for find')
  const walk = (): Promise<CrossResult> =>
    runDispatch(builder, paths, texts, bag, dispatch, cwd, ns, stdin, signal)
  const mounts = ns?.mounts
  if (
    mounts === undefined ||
    predicates(texts).some(([, word]) => WALK_WIDE.has(word)) ||
    new FlagView(bag, specOf('find')).asBool('L')
  )
    return walk()
  const expr = parseFindExpression([...texts])
  const plan: {
    index: number
    start: PathSpec
    alone: boolean
    words: string[]
    bag: Record<string, FlagValue>
  }[] = []
  paths.forEach((path, index) => {
    const base = path.virtual.replace(/\/+$/, '')
    const starts = mountStarts(path, ns)
    const steps: [PathSpec, boolean][] = [
      ...starts.map((start): [PathSpec, boolean] => [start, false]),
      ...joints(path, starts).map((joint): [PathSpec, boolean] => [joint, true]),
    ]
    for (const [start, alone] of steps) {
      const depth =
        start === path ? 0 : (start.virtual.slice(base.length).match(/\//g) ?? []).length
      const limited = shifted(texts, bag, depth, expr.maxDepth, expr.minDepth, alone)
      if (limited !== null) plan.push({ index, start, alone, words: limited[0], bag: limited[1] })
    }
  })
  const ios = await boundedMap(
    plan,
    async (step) => {
      const [out, io] = step.alone
        ? await runDispatch(
            builder,
            [step.start],
            step.words,
            step.bag,
            dispatch,
            cwd,
            ns,
            stdin,
            signal,
          )
        : await runSingle(
            'find',
            [step.start],
            step.words,
            step.bag,
            signal === undefined ? {} : { signal },
          )
      await materialize(out)
      return io
    },
    4,
  )
  // A run that failed found no rows and says why; one that succeeded without
  // structured rows is a find this line cannot compose.
  if (ios.some((io) => io.matchedRuns === null && io.exitCode === 0)) return walk()
  const between = paths.map(
    (_, index) =>
      new Set(plan.filter((s) => s.index === index && s.alone).map((s) => s.start.virtual)),
  )
  const kept = await reached(
    paths,
    plan.map((step) => [step.index, step.start] as const),
    ios.map((io) => io.exitCode !== 0),
    dispatch,
  )
  const done = plan.flatMap((step, i) => {
    const io = ios[i]
    return kept[i] === true && io !== undefined ? [{ step, io }] : []
  })
  const runs: PathSpec[][] = paths.map(() => [])
  let merged = new IOResult()
  for (const { step, io } of done) {
    const owner = mounts.rootOf(step.start.virtual)
    for (const run of io.matchedRuns ?? []) {
      for (const row of run) {
        const kept = step.alone
          ? row.virtual === step.start.virtual
          : mounts.rootOf(row.virtual) === owner &&
            !(between[step.index]?.has(row.virtual) ?? false)
        if (kept) runs[step.index]?.push(row)
      }
    }
    merged = await merged.merge(io)
  }
  for (const rows of runs) rows.sort((a, b) => compareCodePoints(a.virtual, b.virtual))
  merged.exitCode = Math.max(0, ...done.map(({ io }) => io.exitCode))
  merged.matchedRuns = runs
  const body = new TextEncoder().encode(
    runs.flatMap((rows) => rows.map((row) => `${row.rawPath}\n`)).join(''),
  )
  return [body, merged]
}
