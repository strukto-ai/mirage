import type { Runtime } from './base.ts'
import { LanguageRuntime } from './language.ts'
import type { ScriptSource } from './types.ts'
import { buildRuntime } from './table.ts'

/**
 * Build the runtime a config program runs on: the one the config named,
 * with the settings it gave.
 *
 * A policy program that names no runtime arrives here as monty, the
 * default its parser fills in, so a missing `@pydantic/monty` is
 * reported as any missing dependency is, never swapped for another
 * runtime. The runtime is
 * built fresh and never picked out of a workspace's runtime world: the
 * world is the ordered set that serves *agent* code, it is mutable after
 * construction, and an entry drops out of it silently when an optional
 * dependency is missing. Throws a plain Error whose message is a clause
 * about "script", for the caller to prefix with whose script it is.
 * Mirrors the Python `script_engine`.
 */
export function scriptEngine(
  script: ScriptSource,
  runtime: string,
  config: Readonly<Record<string, unknown>> = {},
): LanguageRuntime {
  let built: Runtime
  try {
    built = buildRuntime(runtime, Object.keys(config).length === 0 ? {} : { config })
  } catch (err) {
    // A runtime reports a missing dependency as its own error, each
    // carrying its own install hint.
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`script names runtime '${runtime}': ${detail}`)
  }
  if (!(built instanceof LanguageRuntime)) {
    throw new Error(`script names runtime '${runtime}', which runs no programs`)
  }
  if (built.language !== script.language) {
    throw new Error(
      `script is ${script.language}, but names runtime '${runtime}', which speaks ${built.language}`,
    )
  }
  return built
}
