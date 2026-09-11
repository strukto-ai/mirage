import { describe, expect, it } from 'vitest'

import type { HandOff, Occurrence } from '../../policy/types.ts'
import { commandNodes } from '../../runtime/routing/index.ts'
import { NodeType, type TSNodeLike } from '../../shell/types.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import {
  argvFrame,
  bodyFrame,
  claimantFor,
  evaluatedFrom,
  type Frame,
  lineFrame,
  occurrenceIn,
  occurrenceOf,
  partOf,
  rootFrame,
  segmentFrames,
  wholeOccurrence,
} from './occurrence.ts'

async function parse(line: string): Promise<TSNodeLike> {
  const parser = await getTestParser()
  return parser.parse(line) as unknown as TSNodeLike
}

/** The nth command of a parse, which the test knows is there. */
function command(root: TSNodeLike, index: number): TSNodeLike {
  const node = commandNodes(root)[index]
  if (node === undefined) throw new Error(`no command ${String(index)}`)
  return node
}

function first(node: TSNodeLike, kind: string): TSNodeLike {
  const stack = [node]
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (current.type === kind) return current
    stack.push(...[...current.children].reverse())
  }
  throw new Error(kind)
}

function body(node: TSNodeLike, frame: Frame): Frame {
  const inner = bodyFrame(node, frame)
  if (inner === null) throw new Error('no body')
  return inner
}

function fresh(origin: Occurrence | null = null): HandOff {
  return { claimed: [], parent: null, origin }
}

describe('occurrence', () => {
  it('stands a command at its span in the line', async () => {
    const line = 'touch /tmp/x && cat /data/secret.txt'
    const root = await parse(line)
    const frame = rootFrame(root, null)
    expect(frame).toEqual({ text: line, base: 0, parent: null })
    expect(occurrenceIn(command(root, 0), frame)).toEqual({
      parent: null,
      source: line,
      start: 0,
      end: 12,
    })
    expect(occurrenceIn(command(root, 1), frame)).toEqual({
      parent: null,
      source: line,
      start: 16,
      end: 36,
    })
  })

  it('computes one occurrence for the gate and the pass', async () => {
    // The gate builds the frame from the node it runs and the pass from
    // the tree it walks; on one parse they have to agree.
    const root = await parse('cat /data/secret.txt')
    const node = command(root, 0)
    const handed = fresh()
    expect(occurrenceOf(node, handed)).toEqual(occurrenceIn(node, rootFrame(root, null)))
    expect(claimantFor(node, null)).toBeNull()
    const claimant = claimantFor(node, handed)
    expect(claimant?.line).toBe(handed)
    expect(claimant?.occurrence).toEqual(occurrenceOf(node, handed))
  })

  it('stands a nested line under the node that ran it', async () => {
    // A nested line's hand-off carries the node its text came from, and
    // every command of the nested parse stands under it.
    const outer = await parse("eval 'cat /data/secret.txt'")
    const origin = occurrenceOf(command(outer, 0), fresh())
    const inner = await parse('cat /data/secret.txt')
    const at = occurrenceOf(command(inner, 0), fresh(origin))
    expect(at).toEqual({ parent: origin, source: 'cat /data/secret.txt', start: 0, end: 20 })
    // The pass reads the line the word runs in a frame of its own, and
    // places the same command at the same occurrence.
    expect(occurrenceIn(command(inner, 0), lineFrame('cat /data/secret.txt', origin))).toEqual(at)
  })

  it('reads a substitution body as the nested line parses it', async () => {
    const line = 'echo $(cat /data/secret.txt) && ls'
    const root = await parse(line)
    const frame = rootFrame(root, null)
    const sub = first(root, NodeType.COMMAND_SUBSTITUTION)
    const inner = body(sub, frame)
    expect(inner.text).toBe('cat /data/secret.txt')
    expect(inner.parent).toEqual(occurrenceIn(sub, frame))
    const within = commandNodes(root).find(
      (c) =>
        (c.startIndex ?? 0) > (sub.startIndex ?? 0) && (c.endIndex ?? 0) <= (sub.endIndex ?? 0),
    )
    if (within === undefined) throw new Error('no inner command')
    const walked = occurrenceIn(within, inner)
    // What the nested line computes when it parses the body alone.
    const nested = fresh(occurrenceIn(sub, frame))
    const ran = occurrenceOf(command(await parse(inner.text), 0), nested)
    expect(walked).toEqual(ran)
  })

  it('reads a backtick region as one line per pair', async () => {
    // tree-sitter lexes touching pairs as one node whose subtree merges
    // the two commands into one; the evaluator splits the region and
    // runs each pair as a line of its own, standing at the pair's own
    // span on the line, and the pass reads it the same way.
    const line = 'echo `cat /data/secret.txt` `echo ok`'
    const root = await parse(line)
    const frame = rootFrame(root, null)
    const sub = first(root, NodeType.COMMAND_SUBSTITUTION)
    expect(bodyFrame(sub, frame)).toBeNull()
    const frames = segmentFrames(sub, frame)
    expect(frames.map((f) => f.text)).toEqual(['cat /data/secret.txt', 'echo ok'])
    for (const inner of frames) {
      expect(inner.base).toBe(0)
      const parent = inner.parent
      if (parent === null) throw new Error('no parent')
      expect(line.slice(parent.start, parent.end)).toBe(inner.text)
    }
    // What the nested line computes when expansion hands the executor
    // the pair's span within the node.
    expect(occurrenceOf(sub, fresh(), [1, 21])).toEqual(frames[0]?.parent)
    expect(partOf(occurrenceIn(sub, frame), 1, 21)).toEqual(frames[0]?.parent)
  })

  it('sets a folded prefix aside before a region is split', async () => {
    const line = 'echo "$a `cat /data/secret.txt`"'
    const root = await parse(line)
    const [inner] = segmentFrames(first(root, NodeType.COMMAND_SUBSTITUTION), rootFrame(root, null))
    const parent = inner?.parent ?? null
    if (inner === undefined || parent === null) throw new Error('no segment')
    expect(inner.text).toBe('cat /data/secret.txt')
    expect(line.slice(parent.start, parent.end)).toBe(inner.text)
  })

  it('has no body frame for a node that is no substitution', async () => {
    const root = await parse('(cd /tmp && ls)')
    expect(bodyFrame(first(root, NodeType.SUBSHELL), rootFrame(root, null))).toBeNull()
  })

  it('stands the words a command runs at the whole text', () => {
    const parent: Occurrence = { parent: null, source: 'xargs cat', start: 0, end: 9 }
    expect(wholeOccurrence(lineFrame('cat', parent))).toEqual({
      parent,
      source: 'cat',
      start: 0,
      end: 3,
    })
  })

  it('spells the words a command hands on as the command spells them', async () => {
    // command, env, timeout and xargs each hand the evaluator their
    // words joined with shellJoin, so the nested gate parses the quoted
    // spelling; the pass computes the occurrence on that spelling, and
    // the parse places the command at the whole of it.
    const parent: Occurrence = {
      parent: null,
      source: "command cat '/data/secret file'",
      start: 0,
      end: 31,
    }
    const frame = argvFrame(['cat', '/data/secret file'], parent)
    expect(frame.text).toBe("cat '/data/secret file'")
    const root = await parse(frame.text)
    expect(occurrenceIn(command(root, 0), frame)).toEqual(wholeOccurrence(frame))
  })

  it('ends words holding a multibyte character where the parse ends', async () => {
    // The parser and the string count the same units here; the Python
    // side has to measure bytes for the same assertion to hold.
    const parent: Occurrence = {
      parent: null,
      source: 'command cat /data/secrét',
      start: 0,
      end: 24,
    }
    const frame = argvFrame(['cat', '/data/secrét'], parent)
    const root = await parse(frame.text)
    expect(occurrenceIn(command(root, 0), frame)).toEqual(wholeOccurrence(frame))
  })

  it('stands a pair after a multibyte character at its own span', async () => {
    const line = 'echo `echo é` `cat /data/secret.txt`'
    const root = await parse(line)
    const frames = segmentFrames(first(root, NodeType.COMMAND_SUBSTITUTION), rootFrame(root, null))
    expect(frames.map((f) => f.text)).toEqual(['echo é', 'cat /data/secret.txt'])
    for (const inner of frames) {
      const parent = inner.parent
      if (parent === null) throw new Error('no parent')
      expect(line.slice(parent.start, parent.end)).toBe(inner.text)
    }
  })

  it('stands a line read from a node under it', async () => {
    // One text read from two nodes (an alias invoked twice) is two places
    // on the line: the rewritten line's command is placed under the word
    // that named it, and the line it runs as hands up to the line's own
    // hand-off.
    const handed: HandOff = { claimed: [], parent: null, origin: null }
    const root = await parse('c && c')
    const underFirst = evaluatedFrom(command(root, 0), handed)
    const underSecond = evaluatedFrom(command(root, 1), handed)
    expect(underFirst.parent).toBe(handed)
    expect(underSecond.parent).toBe(handed)
    expect(underFirst.origin).toEqual(occurrenceOf(command(root, 0), handed))
    expect(underFirst.origin).not.toEqual(underSecond.origin)
    const cat = command(await parse('cat /data/secret.txt'), 0)
    expect(occurrenceOf(cat, underFirst).parent).toEqual(underFirst.origin)
    expect(occurrenceOf(cat, underFirst)).not.toEqual(occurrenceOf(cat, underSecond))
  })
})
