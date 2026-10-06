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

import type { SyntaxDiagnostic } from './types.ts'

import type { ShellNode, TSNodeLike } from '../types.ts'

interface Resource {
  references: number
  dispose: (() => void) | null
}

function releaseResource(resource: Resource): void {
  if (resource.dispose === null) return
  const dispose = resource.dispose
  resource.dispose = null
  resource.references = 0
  dispose()
}

// Legacy parse() callers own their nodes through reachability. Execution
// uses explicit leases; this fallback never determines a running scope's lifetime.
const collected = new FinalizationRegistry<Resource>(releaseResource)

export class ParsedProgram {
  readonly root: ProgramNode
  readonly normalized: string
  private readonly resource: Resource
  private released = false

  constructor(
    readonly original: string,
    root: ShellNode,
    readonly offsets: readonly number[],
    dispose: () => void,
    readonly diagnostics: readonly SyntaxDiagnostic[] = [],
  ) {
    this.normalized = root.text
    this.resource = { references: 1, dispose }
    this.root = new ProgramNode(root, this)
    collected.register(this, this.resource, this)
  }

  get references(): number {
    return this.resource.references
  }

  check(): void {
    if (this.resource.references === 0) throw new Error('parsed program is released')
  }

  retain(): () => void {
    this.check()
    this.resource.references += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.drop()
    }
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.drop()
  }

  private drop(): void {
    this.resource.references -= 1
    if (this.resource.references !== 0) return
    collected.unregister(this)
    releaseResource(this.resource)
  }
}

export class ProgramNode implements ShellNode {
  constructor(
    private readonly borrowed: ShellNode,
    readonly program: ParsedProgram,
  ) {}
  private get node(): ShellNode {
    this.program.check()
    return this.borrowed
  }
  get heredoc() {
    return this.node.heredoc
  }
  get timing() {
    return this.node.timing ?? []
  }
  get warnings() {
    return this.node.warnings ?? ''
  }
  get sourceText() {
    return this.node.sourceText ?? this.node.text
  }
  get type(): string {
    return this.node.type
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
    return this.node.childCount
  }
  child(index: number): ProgramNode | null {
    return this.wrap(this.node.child(index))
  }
  get children(): ProgramNode[] {
    return this.node.children.map((node) => new ProgramNode(node, this.program))
  }
  get namedChildren(): ProgramNode[] {
    return this.node.namedChildren.map((node) => new ProgramNode(node, this.program))
  }
  private wrap(node: ShellNode | null): ProgramNode | null {
    return node === null ? null : new ProgramNode(node, this.program)
  }
  get parent(): ProgramNode | null {
    return this.wrap(this.node.parent)
  }
  get previousSibling(): ProgramNode | null {
    return this.wrap(this.node.previousSibling)
  }
  get nextSibling(): ProgramNode | null {
    return this.wrap(this.node.nextSibling)
  }
  childForFieldName(name: string): ProgramNode | null {
    return this.wrap(this.node.childForFieldName(name))
  }
}

/** Retain each defining program once, including synthetic redirect wrappers. */
export function retainPrograms(nodes: readonly TSNodeLike[]): () => void {
  const programs = new Set<ParsedProgram>()
  const pending = [...nodes]
  while (pending.length > 0) {
    const node = pending.pop()
    if (node === undefined) break
    if (node instanceof ProgramNode) programs.add(node.program)
    else if (Array.isArray(node.children)) pending.push(...node.children)
  }
  const leases = [...programs].map((program) => program.retain())
  return () => {
    for (const release of leases) release()
  }
}
