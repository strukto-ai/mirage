import type { Node } from 'web-tree-sitter'
import { badSubstitution } from '../parameter.ts'
import { constructEnd } from './heredoc/line.ts'
import { walkTree } from './names.ts'

/**
 * Spell parameter expansions the way the grammar can read them.
 *
 * GNU Bash 5.2 judges a `${...}` only when the word holding it runs. A
 * substring operand may be malformed arithmetic until then, where
 * tree-sitter requires arithmetic syntax and even rejects valid dollar
 * references, so a same-width default operator gives its word parser
 * ownership of the operand. A `${...}` bash refuses outright
 * (`badSubstitution`) becomes one name of the same width, so the line parses
 * and the expansion fails where bash's does. The caller reads the tree
 * against the original source, so all consumers still read the source as
 * written, and nested substitutions of an expansion that stands remain
 * visible to policy and execution. Mirrors Python's expansion_source.
 */
export function expansionSource(text: string, root: Node): string {
  if (!text.includes('${')) return text
  const opens: [Node, Node[]][] = []
  for (const node of walkTree(root)) {
    for (const [index, child] of node.children.entries()) {
      if (child.type === '${') opens.push([child, node.children.slice(index + 1)])
    }
  }
  const out = text.split('')
  let covered = 0
  for (const [child, tail] of opens.sort((a, b) => a[0].endIndex - b[0].endIndex)) {
    const start = child.endIndex - 2
    const end = constructEnd(text, start, '}')
    if (start < covered || end === null) continue
    if (badSubstitution(text.slice(start, end))) {
      out.fill('a', start + 2, end - 1)
      covered = end
      continue
    }
    if (tail[0]?.type === '!') tail.shift()
    const reference = tail[0]
    const operator = tail[1]
    if (
      reference !== undefined &&
      operator?.type === ':' &&
      ['variable_name', 'special_variable_name', 'subscript'].includes(reference.type)
    )
      out[operator.startIndex] = '-'
  }
  return out.join('')
}
