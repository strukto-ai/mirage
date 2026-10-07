import type { Claimant, HandOff, Occurrence } from '../../policy/types.ts'
import { splitBacktickRegion } from '../../shell/backticks.ts'
import { shellJoin } from '../../shell/join.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { getFunctionName } from '../../shell/helpers.ts'
import type { SessionState } from '../session/session.ts'

/**
 * What opens and closes a substitution's body, in the order the openers
 * are tried; the body between them is the text a nested line is parsed
 * from. A backtick region is not here: tree-sitter lexes touching pairs
 * as one node, so it is split into lines (`segmentFrames`) rather than
 * framed as one body.
 */
export const SUBSTITUTION_DELIMITERS: readonly (readonly [string, string])[] = [
  ['$(', ')'],
  ['<(', ')'],
  ['>(', ')'],
]

/**
 * The text a walk reads commands from, as the line that evaluates it
 * will parse it.
 *
 * The pass walks one tree and computes for every command the occurrence
 * the gate will compute when it runs, and the gate may be running a
 * different parse of the same text: a substitution's body is parsed on
 * its own by the nested line, at offsets that start from zero, while
 * the pass reads it as a subtree of the outer line. The frame is what
 * makes the two agree: `text` is what the nested line parses, `base` is
 * where that text starts in the tree being walked, and `parent` is the
 * occurrence its commands stand under. Mirrors the Python Frame.
 */
export interface Frame {
  readonly text: string
  readonly base: number
  readonly parent: Occurrence | null
}

/** The root of the tree a node belongs to. */
export function rootOf(node: TSNodeLike): TSNodeLike {
  let root = node
  while (root.parent !== null && root.parent !== undefined) root = root.parent
  return root
}

/**
 * The frame of the tree a node belongs to: the text its parse read, at
 * that parse's own offsets.
 *
 * The one rule both readers share. The gate builds it from the node it
 * runs, and the pass from the tree it walks, so a stored function body
 * is placed relative to its definition. Reparsing that source in another
 * worker gives its commands the same approval locations.
 */
export function rootFrame(node: TSNodeLike, parent: Occurrence | null): Frame {
  let root = node
  while (root.parent != null && root.type !== 'function_definition') root = root.parent
  if (root.type === 'function_definition') root = definitionRoot(root)
  return { text: root.text, base: root.startIndex ?? 0, parent }
}

/** A function definition with the redirects stored with it. */
function definitionRoot(node: TSNodeLike): TSNodeLike {
  return node.parent?.type === 'redirected_statement' ? node.parent : node
}

/**
 * The frame of a function body as a pass walks its definition. The body
 * runs from its own parse of the stored source, so its commands stand at
 * offsets from the definition, under the definition's own place on the
 * line: two definitions of one text are two places, each needing a nod
 * of its own. Mirrors Python's definition_frame.
 */
export function definitionFrame(node: TSNodeLike, frame: Frame): Frame {
  const root = definitionRoot(node)
  return { text: root.text, base: root.startIndex ?? 0, parent: occurrenceIn(root, frame) }
}

/**
 * The place a function definition the executor runs stands on its line,
 * which the body's commands stand under when it is called; null outside
 * a line. Mirrors Python's defined_at.
 */
export function definedAt(node: TSNodeLike, handed: HandOff | null): Occurrence | null {
  if (handed === null) return null
  const root = definitionRoot(node)
  if (root.parent == null) {
    return occurrenceIn(root, {
      text: root.text,
      base: root.startIndex ?? 0,
      parent: handed.origin,
    })
  }
  return occurrenceIn(root, rootFrame(root.parent, handed.origin))
}

/** The nearest `function_definition` above a node, or null. */
function enclosingDefinition(node: TSNodeLike): TSNodeLike | null {
  let current = node.parent ?? null
  while (current !== null && current.type !== 'function_definition')
    current = current.parent ?? null
  return current
}

/**
 * The place a call runs a definition's body under, as the gate will find
 * it: `definedAt` for one written on this line (under the definition
 * holding it, for one written inside another), the stored site for a body
 * parsed from the session's table, null for one whose site is gone.
 */
function definitionOrigin(
  definition: TSNodeLike,
  line: TSNodeLike,
  session: SessionState,
  handed: HandOff,
): Occurrence | null {
  const outer = enclosingDefinition(definition)
  if (outer !== null && definition.parent != null) {
    const frame = rootFrame(definition.parent, handed.origin)
    const parent = definitionOrigin(outer, line, session, handed) ?? handed.origin
    return occurrenceIn(definitionRoot(definition), { ...frame, parent })
  }
  // Nodes are fresh objects per read, so the trees are told apart by their
  // roots' ids.
  if (rootOf(definition).id === line.id) return definedAt(definition, handed)
  const name = getFunctionName(definition)
  const site = session.functionSites.get(name)
  if (site === undefined || site.source !== session.functions[name]) return null
  return site.origin
}

/**
 * The frame a node's gate will read it in, for a pass that reads it ahead
 * of the gate: its own tree's, and for a node in a function body under the
 * place the call runs the body under. Mirrors Python's gate_frame.
 */
export function gateFrame(
  node: TSNodeLike,
  line: TSNodeLike,
  session: SessionState,
  handed: HandOff,
): Frame {
  const frame = rootFrame(node, handed.origin)
  const definition = node.type === 'function_definition' ? node : enclosingDefinition(node)
  if (definition === null) return frame
  const origin = definitionOrigin(definition, line, session, handed)
  return origin === null ? frame : { ...frame, parent: origin }
}

/**
 * The frame of a line a word runs (`eval`, `sh -c`), which the pass
 * parses on its own exactly as the nested evaluation will.
 */
export function lineFrame(text: string, parent: Occurrence): Frame {
  return { text, base: 0, parent }
}

/**
 * The frame of the line a command hands the evaluator for words it was
 * given already split (`command`, `env`, `timeout`, `xargs`), spelled
 * as those builtins spell it: joined with shellJoin, so an operand
 * holding a space survives the re-parse as one word.
 *
 * The nested gate parses that spelling, so the pass has to compute the
 * occurrence on it. Joined with a plain space, `cat '/data/secret
 * file'` was read as `cat /data/secret file` and the gate could not
 * find the grant claimed for it.
 */
export function argvFrame(argv: readonly string[], parent: Occurrence): Frame {
  return lineFrame(shellJoin(argv), parent)
}

/** Where a node stands, as a parse of the frame's text would place it. */
export function occurrenceIn(node: TSNodeLike, frame: Frame): Occurrence {
  return {
    parent: frame.parent,
    source: frame.text,
    start: (node.startIndex ?? 0) - frame.base,
    end: (node.endIndex ?? 0) - frame.base,
  }
}

/**
 * The occurrence of a frame's whole text, for words a command runs
 * without a parse of their own (`xargs cat`, `find -exec`).
 *
 * The end is the parser's own unit: web-tree-sitter places a node in
 * UTF-16 code units, which is what a string index counts, so no
 * measuring is needed here. The Python parser counts bytes, and that
 * side measures every span it computes from text (`byte_offset`).
 */
export function wholeOccurrence(frame: Frame): Occurrence {
  return { parent: frame.parent, source: frame.text, start: 0, end: frame.text.length }
}

/**
 * The frame of a substitution's body, as the nested line that evaluates
 * it will parse it: `$( )`, `<( )` or `>( )`, with the whitespace
 * tree-sitter folds into the opening token set aside as expansion sets
 * it aside. Null for a node that is not a substitution the evaluator
 * would run.
 */
export function bodyFrame(node: TSNodeLike, frame: Frame): Frame | null {
  const text = node.text
  const prefix = text.length - text.trimStart().length
  const raw = text.slice(prefix)
  for (const [opener, closer] of SUBSTITUTION_DELIMITERS) {
    if (raw.startsWith(opener) && raw.endsWith(closer)) {
      const body = raw.slice(opener.length, raw.length - closer.length)
      const base = (node.startIndex ?? 0) + prefix + opener.length
      return { text: body, base, parent: occurrenceIn(node, frame) }
    }
  }
  return null
}

/**
 * The occurrence of one span of a node's text, for a node that holds
 * several lines: a backtick region, which tree-sitter lexes as one node
 * when the pairs touch and the evaluator splits again. Each pair is its
 * own place on the line, as it would be had the grammar kept them
 * apart.
 */
export function partOf(occurrence: Occurrence, start: number, end: number): Occurrence {
  return {
    parent: occurrence.parent,
    source: occurrence.source,
    start: occurrence.start + start,
    end: occurrence.start + end,
  }
}

/**
 * The frames of the lines a backtick region runs, one per pair, each to
 * be parsed on its own under the pair's own place on the line; empty
 * for a node that is not a backtick region.
 *
 * The region's subtree is not what runs: tree-sitter lexes touching
 * pairs as one node and merges their commands into one, so the pass
 * reads the region as the evaluator does, split by the one lexer both
 * share (`splitBacktickRegion`), with the folded whitespace set aside
 * first as expansion sets it aside.
 */
export function segmentFrames(node: TSNodeLike, frame: Frame): Frame[] {
  const text = node.text
  const prefix = text.length - text.trimStart().length
  const raw = text.slice(prefix)
  if (!(raw.startsWith('`') && raw.endsWith('`'))) return []
  const at = occurrenceIn(node, frame)
  return splitBacktickRegion(raw)
    .filter((s) => s.command)
    .map((s) => lineFrame(s.text, partOf(at, prefix + s.start, prefix + s.end)))
}

/**
 * Where a node the executor runs stands, on the line it runs in: the
 * line's hand-off carries as `origin` the node the line's text was
 * evaluated from. `span` is the part of the node's text that runs, when
 * the node holds several lines.
 */
export function occurrenceOf(
  node: TSNodeLike,
  handed: HandOff,
  span?: readonly [number, number],
): Occurrence {
  const at = occurrenceIn(node, rootFrame(node, handed.origin))
  return span === undefined ? at : partOf(at, span[0], span[1])
}

/**
 * The hand-off a line read from a node's text runs on.
 *
 * Every re-parse the executor runs is a line of its own: the body a
 * substitution expands, the words `eval` or `xargs` hand on, the line an
 * alias invocation rewrites to. It runs under the hand-off of the
 * subtree reading it and stands at the node whose text it is, so its
 * commands are placed where the outer pass placed them, and one text
 * read from two nodes (`c && c` under one alias) is two places on the
 * line, each needing a nod of its own. What its gates claim goes back
 * to that hand-off when it ends (`Decisions.handUp`). `span` is the part
 * of the node's text that runs, when the node holds several lines.
 * Mirrors the Python `evaluated_from`.
 */
export function evaluatedFrom(
  node: TSNodeLike,
  handed: HandOff,
  span?: readonly [number, number],
): HandOff {
  return { claimed: [], parent: handed, origin: occurrenceOf(node, handed, span) }
}

/**
 * The reader of the ledger for one command the executor runs, null
 * outside a line.
 */
export function claimantFor(node: TSNodeLike, handed: HandOff | null | undefined): Claimant | null {
  if (handed === null || handed === undefined) return null
  return { line: handed, occurrence: occurrenceOf(node, handed) }
}
