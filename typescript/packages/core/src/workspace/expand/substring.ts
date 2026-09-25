import { unescapeUnquoted } from '../../shell/escapes.ts'
import { getText } from '../../shell/helpers.ts'
import type { TSNodeLike } from '../../shell/types.ts'

function span(node: TSNodeLike): [number, number] {
  if (node.startIndex === undefined || node.endIndex === undefined) {
    throw new Error('substring operand has no source span')
  }
  return [node.startIndex, node.endIndex]
}

function atoms(node: TSNodeLike): TSNodeLike[] {
  if (node.type === 'concatenation') return node.children.flatMap(atoms)
  return node.isNamed === true && !['word', 'number'].includes(node.type) ? [node] : []
}

function separator(
  text: string,
  start: number,
  end: number,
  nodes: TSNodeLike[],
  base: number,
): number {
  const opaque = new Map(
    nodes.map((node) => {
      const [start, end] = span(node)
      return [start - base, end - base]
    }),
  )
  let depth = 0
  let ternary = 0
  let index = start
  while (index < end) {
    const next = opaque.get(index)
    if (next !== undefined) {
      index = next
      continue
    }
    const char = text[index] ?? ''
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (depth === 0) {
      if (char === '?') ternary += 1
      else if (char === ':') {
        if (ternary === 0) return index
        ternary -= 1
      }
    }
    index += 1
  }
  return end
}

/**
 * Split offset and length before expanding nested words. Substituted colons
 * are data; quotes, substitutions, subscripts, parentheses and ternaries own
 * their colons. Scalar and array slicing share this path, and arithmetic
 * evaluation applies the offset before requesting the next operand.
 */
export async function* substringOperands(
  node: TSNodeLike,
  expandChild: (node: TSNodeLike) => Promise<string>,
): AsyncGenerator<string> {
  const operator = node.children.find((child) => getText(child) === ':')
  if (operator === undefined) throw new Error('substring operator missing')
  const [base] = span(node)
  const [, operandStart] = span(operator)
  const nodes = node.children
    .filter((child) => span(child)[0] >= operandStart && child.type !== '}')
    .flatMap(atoms)
  const text = getText(node)
  const start = operandStart - base
  const end = text.length - 1
  const split = separator(text, start, end, nodes, base)
  const spans: [number, number][] = [[start, split]]
  if (split < end) spans.push([split + 1, end])
  for (const [begin, stop] of spans) {
    const pieces: string[] = []
    let cursor = begin
    for (const atom of nodes) {
      const [atomStart, atomEnd] = span(atom)
      const left = atomStart - base
      const right = atomEnd - base
      if (begin <= left && right <= stop) {
        pieces.push(unescapeUnquoted(text.slice(cursor, left)))
        pieces.push(await expandChild(atom))
        cursor = right
      }
    }
    pieces.push(unescapeUnquoted(text.slice(cursor, stop)))
    yield pieces.join('')
  }
}
