import type { Claimant, HandOff, Occurrence } from '../../policy/types.ts'
import { splitBacktickRegion } from '../../shell/backticks.ts'
import { shellJoin } from '../../shell/join.ts'
import type { TSNodeLike } from '../../shell/types.ts'

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
 * runs, and the pass from the tree it walks, so a stored function body,
 * kept as the nodes of the line that defined it, is read at invocation
 * exactly as it was judged.
 */
export function rootFrame(node: TSNodeLike, parent: Occurrence | null): Frame {
  const root = rootOf(node)
  return { text: root.text, base: root.startIndex ?? 0, parent }
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
