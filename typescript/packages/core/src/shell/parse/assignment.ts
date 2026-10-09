import { parseProtected } from './recovery.ts'
import type { ShellNode } from '../types.ts'
import type { NativeParser } from './engine.ts'
import { SourceNode } from './source.ts'
import { walkTree } from './names.ts'

const MARKER = ' a='
const SEPARATORS = new Set([';', '&', '&&', '||', '|'])
const REDIRECT_RUN = new Set(['file_redirect', 'comment'])

/** The grammar needs two assignments to recognize an assignment-only redirect.
 * A temporary second assignment selects that production; the adapter removes
 * it and translates every native position back before execution sees the tree.
 * A repaired statement can expose the next one (`a=1 >f; b=2 >g` parses as one
 * command until the first is split off), so the repair repeats until a pass
 * finds no new assignment. */
export function repairAssignments(parser: NativeParser, root: ShellNode, text: string): ShellNode {
  if (!root.hasError) return root
  const positions = new Set<number>()
  let current = root
  for (let pass = text.split('=').length - 1; pass > 0; pass -= 1) {
    const found = [...assignmentEnds(current)].filter((at) => !positions.has(at))
    if (found.length === 0) break
    for (const at of found) positions.add(at)
    const ordered = [...positions].sort((a, b) => a - b)
    let input = text
    for (const position of [...ordered].reverse())
      input = input.slice(0, position) + MARKER + input.slice(position)
    current = new AssignmentNode(
      parseProtected(parser, input),
      text,
      ordered.map((at, i) => at + i * MARKER.length),
    )
  }
  return current
}

/** Where each assignment-only redirect's assignment ends. */
function assignmentEnds(root: ShellNode): Set<number> {
  const positions = new Set<number>()
  for (const node of walkTree(root)) {
    if (node.type !== 'command') continue
    const children = node.children
    const assignment = children[0]
    if (assignment?.type !== 'variable_assignment') continue
    let at = 1
    let redirects = 0
    while (REDIRECT_RUN.has(children[at]?.type ?? '')) {
      if (children[at]?.type === 'file_redirect') redirects += 1
      at += 1
    }
    if (redirects === 0) continue
    const tail = children[at]
    if (
      tail !== undefined &&
      !(
        (tail.type === 'command_name' && tail.text === '') ||
        (tail.type === 'ERROR' && SEPARATORS.has(tail.text.trim()))
      )
    )
      continue
    positions.add(assignment.endIndex)
  }
  return positions
}

class AssignmentNode extends SourceNode {
  constructor(
    node: ShellNode,
    original: string,
    private readonly inserted: readonly number[],
  ) {
    super(node, original)
  }
  private offset(index: number): number {
    let removed = 0
    for (const start of this.inserted)
      removed += Math.max(0, Math.min(MARKER.length, index - start))
    return index - removed
  }
  override get startIndex(): number {
    return this.offset(this.node.startIndex)
  }
  override get endIndex(): number {
    return this.offset(this.node.endIndex)
  }
  override get text(): string {
    return this.original.slice(this.startIndex, this.endIndex)
  }
  private position(index: number): { row: number; column: number } {
    const before = this.original.slice(0, index)
    return { row: before.split('\n').length - 1, column: index - before.lastIndexOf('\n') - 1 }
  }
  override get startPosition() {
    return this.position(this.startIndex)
  }
  override get endPosition() {
    return this.position(this.endIndex)
  }
  protected override wrap(node: ShellNode | null): AssignmentNode | null {
    return node === null ? null : new AssignmentNode(node, this.original, this.inserted)
  }
  private visible(node: ShellNode): boolean {
    return !(node.type === 'variable_assignment' && this.inserted.includes(node.startIndex - 1))
  }
  override get children(): AssignmentNode[] {
    return this.node.children
      .filter((n) => this.visible(n))
      .map((n) => this.wrap(n))
      .filter((n) => n !== null)
  }
  override get namedChildren(): AssignmentNode[] {
    return this.node.namedChildren
      .filter((n) => this.visible(n))
      .map((n) => this.wrap(n))
      .filter((n) => n !== null)
  }
  override get childCount(): number {
    return this.children.length
  }
  override child(index: number): AssignmentNode | null {
    return this.children[index] ?? null
  }
  override get nextSibling(): AssignmentNode | null {
    let node = this.node.nextSibling
    while (node !== null && !this.visible(node)) node = node.nextSibling
    return this.wrap(node)
  }
  override get previousSibling(): AssignmentNode | null {
    let node = this.node.previousSibling
    while (node !== null && !this.visible(node)) node = node.previousSibling
    return this.wrap(node)
  }
}
