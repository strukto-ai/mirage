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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/types.ts'
import {
  DEFAULT_INDENT,
  argsObject,
  concatBytes,
  evalJsonlStream,
  formatJqOutput,
  isJsonlPath,
  isStreamableJsonlExpr,
  jqEval,
  jqOptions,
  parseJsonDocs,
  parseSeqDocs,
  referencesArgs,
  referencesInputs,
  splitRawLines,
  streamEvents,
  type JqOptions,
} from '../../../core/jq/index.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { readStdinAsync } from '../utils/stream.ts'

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

const DEC = new TextDecoder()
const INDENT_MIN = -1
const INDENT_MAX = 7
const USAGE_HINT =
  'Use jq --help for help with command-line options,\n' +
  'or see the jq manpage, or online docs  at https://jqlang.github.io/jq'

/** Read a pair option's flattened values back as [name, value]. */
function pairArgs(values: readonly string[]): [string, string][] {
  const pairs: [string, string][] = []
  for (let i = 0; i + 1 < values.length; i += 2) {
    pairs.push([values[i] ?? '', values[i + 1] ?? ''])
  }
  return pairs
}

/** Collect the $name bindings from --arg and --argjson. */
export function namedArgs(fl: FlagView): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const [name, value] of pairArgs(fl.asList('arg'))) args[name] = value
  for (const [name, value] of pairArgs(fl.asList('argjson'))) {
    try {
      args[name] = JSON.parse(value) as unknown
    } catch {
      throw new UsageError(`jq: invalid JSON text passed to --argjson\n${USAGE_HINT}`, 2)
    }
  }
  return args
}

/**
 * Values `$ARGS.positional` reports, from --args / --jsonargs.
 *
 * The operands after the program stop being input files once either flag
 * appears, so they arrive here as ordinary text.
 */
export function positionalArgs(
  fl: FlagView,
  texts: readonly string[],
  hasProgramFile: boolean,
): unknown[] {
  const asJson = fl.asBool('jsonargs')
  if (!asJson && !fl.asBool('args')) return []
  const rest = hasProgramFile ? [...texts] : texts.slice(1)
  if (!asJson) return rest
  return rest.map((value) => {
    try {
      return JSON.parse(value) as unknown
    } catch {
      throw new UsageError(`jq: invalid JSON text passed to --jsonargs\n${USAGE_HINT}`, 2)
    }
  })
}

/**
 * Collect the $name bindings that read a file.
 *
 * --rawfile binds the file's text, --slurpfile the array of documents in
 * it, which is the same difference -R draws on the input stream.
 */
async function fileArgs(
  fl: FlagView,
  toSpec: (value: string) => PathSpec,
  stream: Stream,
): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = {}
  for (const [name, value] of pairArgs(fl.asList('rawfile'))) {
    args[name] = DEC.decode(await materialize(stream(toSpec(value))))
  }
  for (const [name, value] of pairArgs(fl.asList('slurpfile'))) {
    args[name] = parseJsonDocs(await materialize(stream(toSpec(value))))
  }
  return args
}

/**
 * Read the raw jq flag kwargs into a frozen struct.
 *
 * Two deliberate divergences from jq's own parser, both from mirage
 * parsing a whole line before acting on it rather than one option at a
 * time. jq lets `-c`, `--tab` and `--indent` override each other in the
 * order typed; here `-c` wins whenever it appears. And jq reads a
 * non-numeric `--indent` as 0 (C atoi), where mirage refuses it like
 * every other int-typed option.
 */
export function parseFlags(fl: FlagView): JqOptions {
  const width = fl.asInt('indent')
  if (width !== undefined && (width < INDENT_MIN || width > INDENT_MAX)) {
    throw new UsageError(
      `jq: --indent takes a number between ${String(INDENT_MIN)} and ` +
        `${String(INDENT_MAX)}\n${USAGE_HINT}`,
      2,
    )
  }
  const joinOutput = fl.asBool('join_output')
  const nulOutput = fl.asBool('raw_output0')
  return jqOptions({
    nullInput: fl.asBool('null_input'),
    rawInput: fl.asBool('raw_input'),
    slurp: fl.asBool('slurp'),
    stream: fl.asBool('stream'),
    seq: fl.asBool('seq'),
    // -j and --raw-output0 are -r plus a different separator.
    rawOutput: fl.asBool('raw_output') || joinOutput || nulOutput,
    joinOutput,
    nulOutput,
    compact: fl.asBool('compact_output'),
    asciiOutput: fl.asBool('ascii_output'),
    sortKeys: fl.asBool('sort_keys'),
    // jq spells tab indentation both ways: --tab, or --indent -1.
    tab: fl.asBool('tab') || width === INDENT_MIN,
    indent: width === undefined || width === INDENT_MIN ? DEFAULT_INDENT : width,
    exitStatus: fl.asBool('exit_status'),
    namedArgs: namedArgs(fl),
  })
}

/**
 * Turn the raw inputs into the value stream the program sees.
 *
 * jq reads every file and stdin as one stream, so slurping spans them all
 * rather than restarting per file. Line splitting stays per input: a file
 * with no trailing newline ends its last line there instead of joining it
 * to the next file's first.
 */
export async function assembleInputs(
  chunks: readonly Uint8Array[],
  opts: JqOptions,
): Promise<unknown[]> {
  if (opts.rawInput) {
    if (opts.slurp) return [DEC.decode(concatBytes(chunks))]
    return chunks.flatMap((chunk) => splitRawLines(chunk))
  }
  const parse = opts.seq ? parseSeqDocs : parseJsonDocs
  let docs = chunks.flatMap((chunk) => parse(chunk))
  if (opts.stream) {
    // --stream replaces each document with its events, and slurping then
    // collects the events rather than the documents.
    docs = (await Promise.all(docs.map((doc) => streamEvents(doc)))).flat()
  }
  return opts.slurp ? [docs] : docs
}

/** Exit status for a run, which only -e makes interesting. */
export function exitCode(outputs: readonly unknown[], opts: JqOptions): number {
  if (!opts.exitStatus) return 0
  if (outputs.length === 0) return 4
  const last = outputs[outputs.length - 1]
  return last === null || last === false ? 1 : 0
}

// Path flags arrive as resolved virtual-path strings, so a flag that
// names a file builds its own PathSpec against the operands' mount.
function pathSpecFactory(
  paths: readonly PathSpec[],
  opts: CommandOpts,
): (value: string) => PathSpec {
  const first = paths[0]
  const mountPrefix =
    (first === undefined ? undefined : mountPrefixOf(first.virtual, first.resourcePath)) ??
    opts.mountPrefix ??
    ''
  return (value) => PathSpec.fromStrPath(value, mountKey(value, mountPrefix))
}

async function programText(
  texts: readonly string[],
  fl: FlagView,
  toSpec: (value: string) => PathSpec,
  stream: Stream,
): Promise<string> {
  const fromFile = fl.asStr('from_file')
  // jq defaults the filter to "." when no expression is given.
  if (fromFile === undefined) return texts[0] ?? '.'
  return DEC.decode(await materialize(stream(toSpec(fromFile))))
}

export async function jqGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: Stream,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('jq'))
  const toSpec = pathSpecFactory(paths, opts)
  const hasProgramFile = fl.asStr('from_file') !== undefined
  const expr = (await programText(texts, fl, toSpec, stream)).trim()
  const wantsInputs = referencesInputs(expr)
  // --rawfile / --slurpfile read a file each, so they join the bindings
  // only once the backend reader is in hand.
  const base = parseFlags(fl)
  const jq: JqOptions = jqOptions({
    ...base,
    namedArgs: { ...base.namedArgs, ...(await fileArgs(fl, toSpec, stream)) },
    positionalArgs: positionalArgs(fl, texts, hasProgramFile),
  })
  const argsValue = referencesArgs(expr) ? argsObject(jq) : null

  // The per-line path rewrites the program to run on one element, so it
  // can only serve a run whose input stream is the file's documents and
  // whose exit code does not depend on the last of them.
  const first = paths[0]
  if (
    first !== undefined &&
    isJsonlPath(first.virtual) &&
    isStreamableJsonlExpr(expr) &&
    !jq.nullInput &&
    !jq.rawInput &&
    !jq.slurp &&
    !jq.stream &&
    !jq.seq &&
    !jq.exitStatus &&
    !wantsInputs
  ) {
    return [evalJsonlStream(stream(first), expr, jq), new IOResult()]
  }

  const chunks: Uint8Array[] = []
  // -n does not read its inputs at all unless the program asks for them
  // through `inputs`, which is why jq -n never opens a missing file.
  if (!jq.nullInput || wantsInputs) {
    if (paths.length > 0) {
      for (const path of paths) chunks.push(await materialize(stream(path)))
    } else {
      const stdinBytes = await readStdinAsync(opts.stdin)
      if (stdinBytes !== null) chunks.push(stdinBytes)
    }
  }
  const docs = await assembleInputs(chunks, jq)

  const outputs: unknown[] = []
  if (jq.nullInput) {
    outputs.push(...(await jqEval(null, expr, jq.namedArgs, wantsInputs ? docs : null, argsValue)))
  } else if (wantsInputs) {
    // `inputs` consumes from the same stream the main loop reads, so a
    // program that drains it runs once. How much it drains is a runtime
    // fact this evaluator does not report, so mirage assumes the whole
    // rest, which is what the idiom (`[., inputs]`, `reduce inputs as $x`)
    // does; a program that takes only some of them (`first(inputs)`) would
    // leave the remainder for another pass in real jq and does not here.
    if (docs.length > 0) {
      outputs.push(...(await jqEval(docs[0], expr, jq.namedArgs, docs.slice(1), argsValue)))
    }
  } else {
    // jq applies the program to every document in the stream.
    for (const doc of docs) {
      outputs.push(...(await jqEval(doc, expr, jq.namedArgs, null, argsValue)))
    }
  }
  const out: ByteSource = formatJqOutput(outputs, jq)
  return [out, new IOResult({ exitCode: exitCode(outputs, jq) })]
}
