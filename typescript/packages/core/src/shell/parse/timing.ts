import type { NativeParser, WrappedNode } from './engine.ts'
import type { HeredocNode } from './heredoc/node.ts'
import type { ShellNode } from '../types.ts'
import type { HeredocSource } from './heredoc/types.ts'
import { walkTree } from './names.ts'

const PREFIX =
  /^time(?=[ \t\r\n;|&)]|$)[ \t]*(?:(-p)(?=[ \t\r\n;|&)]|$)[ \t]*)?(?:--(?=[ \t\r\n;|&)]|$)[ \t]*)?/
const COMPOUND_HEADS = new Set(['{', 'if', 'for', 'select', 'while', 'until', 'case', '!', 'time'])
const STATEMENTS = new Set([
  'command',
  'test_command',
  'arithmetic_expansion',
  'pipeline',
  'redirected_statement',
  'negated_command',
  'subshell',
  'compound_statement',
  'if_statement',
  'for_statement',
  'while_statement',
  'case_statement',
  'c_style_for_statement',
])
export type TimingMark = readonly [number, string, boolean, number, number]

function sourceOffset(source: HeredocSource, index: number): number {
  const offset = source.offsets[index]
  if (offset === undefined) throw new Error('timing prefix outside source map')
  return offset
}

/** Remove reserved prefixes so the grammar can read the complete pipeline/compound body. */
export function lowerTiming(
  parser: NativeParser,
  source: HeredocSource,
): [HeredocSource, TimingMark[]] {
  let text = source.source
  let marks: TimingMark[] = []
  for (;;) {
    const root = parser.parse(text)?.rootNode
    if (root === undefined) break
    const edits: [number, number, string][] = []
    for (const node of walkTree(root)) {
      const negated = node.type === 'negated_command'
      if (negated) {
        const body = node.namedChildren[0]
        const head = body?.childForFieldName('name')
        const arith = body?.text.startsWith('((') === true
        if (!arith && (head == null || !COMPOUND_HEADS.has(head.text))) continue
      }
      const name = negated ? node.children[0] : node.childForFieldName('name')
      if (name == null) continue
      if (
        !negated &&
        (node.type !== 'command' || name.text !== 'time' || node.children[0]?.id !== name.id)
      )
        continue
      if (node.parent?.type === 'pipeline' && node.parent.namedChildren[0]?.id !== node.id) continue
      const match = negated ? null : PREFIX.exec(text.slice(name.startIndex))
      if (!negated && match === null) continue
      let end = match === null ? name.endIndex : name.startIndex + match[0].length
      while (end < text.length && [' ', '\t'].includes(text.charAt(end))) end += 1
      const empty = end === text.length || ['\n', ';', '&', ')'].includes(text.charAt(end))
      let replacement = ' '.repeat(end - name.startIndex)
      let anchor = end
      if (empty) {
        replacement = ':' + replacement.slice(1)
        anchor = name.startIndex
      }
      marks = marks.map(([position, kind, flag, begin, finish]) => [
        position === source.offsets[name.startIndex] ? sourceOffset(source, anchor) : position,
        kind,
        flag,
        begin,
        finish,
      ])
      marks.push([
        sourceOffset(source, anchor),
        negated ? 'negated_command' : 'timed_statement',
        match?.[1] !== undefined,
        sourceOffset(source, name.startIndex),
        sourceOffset(source, end),
      ])
      edits.push([name.startIndex, end, replacement])
    }
    if (edits.length === 0) break
    for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0]))
      text = text.slice(0, start) + replacement + text.slice(end)
  }
  return [{ ...source, source: text }, marks]
}

export class PrefixNode implements WrappedNode {
  readonly timing: readonly boolean[]
  private readonly prefixes: readonly (readonly [string, boolean])[]
  constructor(
    private readonly node: HeredocNode,
    private readonly targets: ReadonlyMap<number, readonly (readonly [string, boolean])[]>,
    private readonly source: HeredocSource,
    private readonly spans: readonly (readonly [number, number])[],
    private readonly skip = 0,
    private readonly parentNode: PrefixNode | null = null,
  ) {
    this.prefixes = (targets.get(node.id) ?? []).slice(skip)
    const first = this.prefixes[0]
    this.timing = first === undefined ? [] : [first[1]]
  }
  get inner(): ShellNode {
    return this.node
  }
  get type(): string {
    return this.prefixes[0]?.[0] ?? this.node.type
  }
  get text(): string {
    return this.node.text
  }
  get id(): number {
    return this.node.id
  }
  get startIndex(): number {
    return this.node.startIndex
  }
  get endIndex(): number {
    return this.node.endIndex
  }
  get startPosition() {
    return this.node.startPosition
  }
  get endPosition() {
    return this.node.endPosition
  }
  get isNamed(): boolean {
    return this.node.isNamed
  }
  get isMissing(): boolean {
    return this.node.isMissing
  }
  get hasError(): boolean {
    return this.node.hasError
  }
  get childCount(): number {
    return this.children.length
  }
  child(index: number): PrefixNode | null {
    return this.children[index] ?? null
  }
  get children(): PrefixNode[] {
    return this.timing.length > 0
      ? [new PrefixNode(this.node, this.targets, this.source, this.spans, this.skip + 1, this)]
      : this.node.children.map(
          (node) => new PrefixNode(node, this.targets, this.source, this.spans, 0, this),
        )
  }
  get namedChildren(): PrefixNode[] {
    return this.timing.length > 0
      ? this.children
      : this.node.namedChildren.map(
          (node) => new PrefixNode(node, this.targets, this.source, this.spans, 0, this),
        )
  }
  private wrap(node: HeredocNode | null, parent: PrefixNode | null = null): PrefixNode | null {
    return node === null
      ? null
      : new PrefixNode(node, this.targets, this.source, this.spans, 0, parent)
  }
  get parent(): PrefixNode | null {
    return this.parentNode ?? this.wrap(this.node.parent)
  }
  get previousSibling(): PrefixNode | null {
    return this.wrap(this.node.previousSibling)
  }
  get nextSibling(): PrefixNode | null {
    return this.wrap(this.node.nextSibling)
  }
  childForFieldName(name: string): PrefixNode | null {
    return this.wrap(this.node.childForFieldName(name), this)
  }
  get offsets(): readonly number[] {
    return this.source.offsets
  }
  get sourceText(): string {
    if (this.source.documents.some(([start]) => this.startIndex <= start && start < this.endIndex))
      return this.node.sourceText
    const text = this.node.text.split('')
    for (let index = this.startIndex; index < this.endIndex; index += 1) {
      const offset = sourceOffset(this.source, index)
      if (this.spans.some(([start, end]) => start <= offset && offset < end))
        text[index - this.startIndex] = this.source.original.charAt(offset)
    }
    return text.join('')
  }
  get heredoc() {
    return this.node.heredoc
  }
  get inlined(): string | undefined {
    return this.node.inlined
  }
  get warnings(): string {
    return this.node.warnings
  }
}

function spansList(node: HeredocNode): boolean {
  while (
    (node.type === 'redirected_statement' || node.type === 'pipeline') &&
    node.namedChildren.length > 0
  ) {
    const first = node.namedChildren[0]
    if (first === undefined) break
    node = first
  }
  return node.type === 'list'
}

/** Attach each prefix to the complete next pipeline, stopping at list boundaries. */
export function wrapTiming(
  root: HeredocNode,
  source: HeredocSource,
  marks: readonly TimingMark[],
): PrefixNode {
  const targets = new Map<number, readonly (readonly [string, boolean])[]>()
  for (const [position, kind, portable] of marks) {
    const stack = [root]
    while (stack.length > 0) {
      const node = stack.pop()
      if (node === undefined) break
      if (
        STATEMENTS.has(node.type) &&
        source.offsets[node.startIndex] === position &&
        !spansList(node)
      ) {
        const prefixes = [...(targets.get(node.id) ?? [])]
        const previous = prefixes.at(-1)
        if (kind === 'timed_statement' && previous?.[0] === kind)
          prefixes[prefixes.length - 1] = [kind, portable || previous[1]]
        else prefixes.push([kind, portable])
        targets.set(node.id, prefixes)
        break
      }
      stack.push(...[...node.namedChildren].reverse())
    }
  }
  return new PrefixNode(
    root,
    targets,
    source,
    marks.map(([, , , start, end]) => [start, end]),
  )
}
