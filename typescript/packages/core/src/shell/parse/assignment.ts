import { parseProtected } from './recovery.ts'
import type { ShellNode } from '../types.ts'
import type { NativeParser } from './engine.ts'
import { SourceNode } from './source.ts'

const MARKER = ' a='
const SEPARATORS = new Set([';', '&', '&&', '||', '|'])

/** The grammar needs two assignments to recognize an assignment-only redirect.
 * A temporary second assignment selects that production; the adapter removes
 * it and translates every native position back before execution sees the tree. */
export function repairAssignments(parser: NativeParser, root: ShellNode, text: string): ShellNode {
  if (!root.hasError) return root
  const positions = new Set<number>()
  const pending = [root]
  while (pending.length > 0) {
    const node = pending.pop()
    if (node === undefined) break
    pending.push(...node.children)
    if (node.type !== 'command') continue
    const children = node.children
    const assignment = children[0]
    if (assignment?.type !== 'variable_assignment') continue
    let at = 1
    while (children[at]?.type === 'file_redirect') at += 1
    if (at === 1) continue
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
  if (positions.size === 0) return root
  let input = text
  const ordered = [...positions].sort((a, b) => a - b)
  for (const position of [...ordered].reverse())
    input = input.slice(0, position) + MARKER + input.slice(position)
  const retried = parseProtected(parser, input)
  return new AssignmentNode(
    retried,
    text,
    ordered.map((at, i) => at + i * MARKER.length),
  )
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
