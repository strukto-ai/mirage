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

import { decodeAnsiC } from './escapes.ts'
import {
  REDIRECT_NODE_TYPES,
  getCaseItems,
  getForParts,
  getFunctionRedirects,
  getText,
  parseFunction,
} from './helpers.ts'
import type { ParseScope } from './parse/scope.ts'
import { BASH_KEYWORDS } from './parse/constants.ts'
import { delimiterEnd } from './parse/heredoc/reader.ts'
import type { Heredoc } from './parse/heredoc/types.ts'
import { NodeType as NT, type TSNodeLike } from './types.ts'
import { singleQuote } from '../utils/quote.ts'

const INDENT = '    '
const CONTINUATION = /\\\n[ \t]*/g
// A name bash would read as a reserved word is printed after `function`.
const RESERVED: ReadonlySet<string> = new Set([
  ...BASH_KEYWORDS,
  '!',
  '{',
  '}',
  '[[',
  ']]',
  'time',
  'coproc',
])

/** Render a portable definition without keeping its parsed tree. */
export function storedFunctionText(name: string, source: string, parser?: ParseScope): string {
  if (parser === undefined) throw new Error('function rendering requires a parse scope')
  const scope = parser.fork()
  try {
    return functionText(
      name,
      parseFunction(source, (line) => scope.parse(line)),
    )
  } finally {
    scope.release()
  }
}

/**
 * A function as `declare -f` and `type` print it. bash prints its own
 * rendering of the parsed definition, not the text that was typed: a
 * body of statements one per line with four-space indents,
 * `;` between them, `elif` as an `if` nested in `else`, redirects respelled
 * after the words (`>&2` is `1>&2`), `$'...'` decoded into single quotes,
 * and every substitution's command printed the same way. Mirrors Python's
 * function_text.
 */
export function functionText(name: string, body: readonly TSNodeLike[]): string {
  return new Printer(true).definition(name, definitionOf(body), '')
}

function definitionOf(body: readonly TSNodeLike[]): TSNodeLike {
  let node = body[0]
  if (node === undefined) throw new Error('function: empty body')
  if (node.parent == null && node.type === NT.REDIRECTED_STATEMENT) node = node.children[0] ?? node
  let parent = node.parent ?? null
  while (parent !== null && parent.type !== NT.FUNCTION_DEFINITION) parent = parent.parent ?? null
  return parent ?? node
}

function start(node: TSNodeLike): number {
  return node.startIndex ?? 0
}

function end(node: TSNodeLike): number {
  return node.endIndex ?? 0
}

function stripContinuations(text: string): string {
  return text.replace(CONTINUATION, '')
}

/**
 * One rendering: inside a function body or a substitution's own top level,
 * which prints its `;` and newline separators as typed. Heredoc bodies wait
 * for the end of the line their operator is on.
 */
class Printer {
  deferred: string[] = []
  constructor(readonly inFunction: boolean) {}

  definition(name: string, node: TSNodeLike, indent: string): string {
    const body = node.childForFieldName?.('body') ?? null
    const inner = indent + INDENT
    const text =
      body === null
        ? ''
        : body.type === NT.COMPOUND_STATEMENT
          ? this.statements(body.children, inner, false)
          : this.command(body, inner)
    const keyword = indent !== '' || RESERVED.has(name)
    const head = `${keyword ? 'function ' : ''}${name} () \n`
    let out = `${head}${indent}{ \n${inner}${text}\n${indent}}${this.redirects(getFunctionRedirects(node))}`
    // The definition's own heredocs follow its line, as bash prints them;
    // a nested definition's wait for the statement it ends.
    if (indent === '' && this.deferred.length > 0) {
      out += '\n' + this.deferred.join('')
      this.deferred = []
    }
    return out
  }

  /**
   * A list of statements: each on its own line under `indent`, `;` between
   * them, after the last one too when `trailing` (the body of an `if` or a
   * loop); `&` keeps the next on its line.
   */
  statements(children: readonly TSNodeLike[], indent: string, trailing: boolean): string {
    const parts: TSNodeLike[] = []
    const background = new Set<number>()
    const newlineAfter = new Set<number>()
    for (const child of children) {
      if (child.type === '&' && parts.length > 0) background.add(parts.length - 1)
      else if (child.isNamed === true && child.type !== NT.COMMENT) {
        const previous = parts[parts.length - 1]
        if (previous !== undefined && newlineBetween(previous, child))
          newlineAfter.add(parts.length - 1)
        parts.push(child)
      }
    }
    let out = ''
    parts.forEach((part, index) => {
      out += this.command(part, indent)
      const heredoc = this.deferred.length > 0
      if (heredoc) {
        out += `\n${this.deferred.join('')}`
        this.deferred = []
      }
      const last = index === parts.length - 1
      if (background.has(index)) out += last ? ' &' : ' & '
      else if (heredoc) out += last ? '' : `\n${indent}`
      else if (!last)
        out += this.inFunction ? `;\n${indent}` : newlineAfter.has(index) ? '\n' : '; '
      else if (trailing) out += ';'
    })
    return out
  }

  /** One statement, its compound bodies indented under `indent`. */
  command(node: TSNodeLike, indent: string): string {
    const kind = node.type
    const named = node.namedChildren
    if (kind === NT.REDIRECTED_STATEMENT) {
      const body = named[0]
      if (body === undefined || REDIRECT_NODE_TYPES.has(body.type))
        return this.redirects(named).trimStart()
      const redirects = named.slice(1).filter((c) => REDIRECT_NODE_TYPES.has(c.type))
      if (body.type === NT.FUNCTION_DEFINITION)
        return this.definition(getText(body.namedChildren[0] ?? body), body, indent)
      return this.command(body, indent) + this.redirects(redirects)
    }
    if (kind === NT.COMMAND) {
      const words = named.filter((c) => !REDIRECT_NODE_TYPES.has(c.type)).map((c) => this.word(c))
      return words.join(' ') + this.redirects(named.filter((c) => REDIRECT_NODE_TYPES.has(c.type)))
    }
    if (kind === NT.PIPELINE) return this.pipeline(node, indent)
    if (kind === NT.LIST) {
      const op = node.children.find((c) => c.isNamed !== true)?.type ?? '&&'
      return `${this.command(named[0] ?? node, indent)} ${op} ${this.command(named[1] ?? node, indent)}`
    }
    if (kind === 'negated_command') return `! ${this.command(named[0] ?? node, indent)}`
    if (kind === 'timed_statement')
      return `${node.timing?.[0] === true ? 'time -p ' : 'time '}${this.command(named[0] ?? node, indent)}`
    if (kind === NT.SUBSHELL) return `( ${this.statements(node.children, indent, false)} )`
    if (kind === 'test_command' && getText(node).startsWith('[['))
      return `[[ ${this.condition(named[0] ?? node)} ]]`
    if (kind === NT.COMPOUND_STATEMENT) {
      if (node.children[0]?.type === '((') return stripContinuations(getText(node))
      const inner = indent + INDENT
      return `{ \n${inner}${this.statements(node.children, inner, false)}\n${indent}}`
    }
    if (kind === NT.IF_STATEMENT) return this.ifStatement(node, indent)
    if (kind === NT.WHILE_STATEMENT || kind === 'until_statement') return this.loop(node, indent)
    if (kind === NT.FOR_STATEMENT) return this.forStatement(node, indent)
    if (kind === 'c_style_for_statement') return this.cfor(node, indent)
    if (kind === NT.CASE_STATEMENT) return this.caseStatement(node, indent)
    if (kind === NT.FUNCTION_DEFINITION)
      return this.definition(getText(named[0] ?? node), node, indent)
    if (
      kind === 'variable_assignments' ||
      kind === 'declaration_command' ||
      kind === 'unset_command'
    ) {
      const words = named.map((c) => this.word(c))
      const first = node.children[0]
      if (first !== undefined && first.isNamed !== true) words.unshift(getText(first))
      return words.join(' ')
    }
    return this.word(node)
  }

  /**
   * A `[[ ]]` expression as bash prints its parsed form: one space around
   * each operator, and a bare operand tested with `-n`.
   */
  condition(node: TSNodeLike): string {
    const kind = node.type
    const named = node.namedChildren
    const [first, second] = named
    if (kind === 'binary_expression' && first !== undefined && second !== undefined) {
      const op = getText(node.children.find((c) => c.isNamed !== true) ?? node)
      if (op === '&&' || op === '||')
        return `${this.condition(first)} ${op} ${this.condition(second)}`
      return `${this.word(first)} ${op} ${this.word(second)}`
    }
    const operand = named[named.length - 1]
    const opNode = node.children[0]
    if (kind === 'unary_expression' && operand !== undefined && opNode !== undefined) {
      const op = getText(opNode)
      if (op === '!' && end(opNode) < start(operand)) return `! ${this.condition(operand)}`
      if (op !== '!') return `${op} ${this.word(operand)}`
    }
    if (kind === 'parenthesized_expression' && first !== undefined)
      return `( ${this.condition(first)} )`
    return `-n ${this.word(node)}`
  }

  private pipeline(node: TSNodeLike, indent: string): string {
    let out = ''
    for (const child of node.children) {
      if (child.type === '|') out += ' |'
      else if (child.type === '|&') out += ' 2>&1 |'
      else if (child.isNamed === true) {
        if (out !== '') {
          out += this.deferred.length > 0 ? `\n${this.deferred.join('')}  ` : ' '
          this.deferred = []
        }
        out += this.command(child, indent)
      }
    }
    return out
  }

  private ifStatement(node: TSNodeLike, indent: string): string {
    const branches: [TSNodeLike[], TSNodeLike[]][] = []
    let otherwise: TSNodeLike[] | null = null
    let condition: TSNodeLike[] = []
    let body: TSNodeLike[] = []
    let target = condition
    for (const child of node.children) {
      if (child.type === 'if' || child.type === 'elif') target = condition
      else if (child.type === 'then') target = body
      else if (
        child.type === NT.ELIF_CLAUSE ||
        child.type === NT.ELSE_CLAUSE ||
        child.type === 'fi'
      ) {
        if (condition.length > 0 || body.length > 0) {
          branches.push([condition, body])
          condition = []
          body = []
        }
        if (child.type === NT.ELIF_CLAUSE) {
          target = condition
          for (const part of child.children) {
            if (part.type === 'elif') target = condition
            else if (part.type === 'then') target = body
            else target.push(part)
          }
          branches.push([condition, body])
          condition = []
          body = []
        } else if (child.type === NT.ELSE_CLAUSE) {
          otherwise = child.children.filter((part) => part.type !== 'else')
        }
      } else target.push(child)
    }
    return this.branches(branches, otherwise, indent)
  }

  private branches(
    branches: readonly [TSNodeLike[], TSNodeLike[]][],
    otherwise: TSNodeLike[] | null,
    indent: string,
  ): string {
    const [condition, body] = branches[0] ?? [[], []]
    const inner = indent + INDENT
    let out = `if ${this.statements(condition, indent, false)}; then\n${inner}${this.statements(body, inner, true)}\n`
    if (branches.length > 1)
      out += `${indent}else\n${inner}${this.branches(branches.slice(1), otherwise, inner)};\n`
    else if (otherwise !== null)
      out += `${indent}else\n${inner}${this.statements(otherwise, inner, true)}\n`
    return `${out}${indent}fi`
  }

  private loop(node: TSNodeLike, indent: string): string {
    const condition = node.children.filter(
      (c) => c.type !== 'while' && c.type !== 'until' && c.type !== NT.DO_GROUP,
    )
    const group = node.children.find((c) => c.type === NT.DO_GROUP) ?? null
    const head = node.children[0]?.type ?? 'while'
    return `${head} ${this.statements(condition, indent, false)}; do${this.group(group, indent)}`
  }

  private group(group: TSNodeLike | null, indent: string): string {
    const children = (group?.children ?? []).filter((c) => c.type !== 'do' && c.type !== 'done')
    const inner = indent + INDENT
    return `\n${inner}${this.statements(children, inner, true)}\n${indent}done`
  }

  private forStatement(node: TSNodeLike, indent: string): string {
    const [variable, values] = getForParts(node)
    const words = values.map((v) => this.word(v)).join(' ')
    const group = node.children.find((c) => c.type === NT.DO_GROUP) ?? null
    const head = node.children[0]?.type ?? 'for'
    return `${head} ${variable} in ${words};\n${indent}do${this.group(group, indent)}`
  }

  private cfor(node: TSNodeLike, indent: string): string {
    const source = node.text
    const base = start(node)
    const slots: string[] = []
    let begin: number | null = null
    for (const child of node.children) {
      if (child.type !== '((' && child.type !== ';' && child.type !== '))') continue
      if (begin === null && child.type !== '((') continue
      if (begin !== null) {
        const text = source.slice(begin - base, start(child) - base).trimStart()
        slots.push(text === '' ? '1' : text)
      }
      if (child.type === '))') break
      begin = end(child)
    }
    const group = node.children.find((c) => c.type === NT.DO_GROUP) ?? null
    return `for ((${slots.join('; ')}))\n${indent}do${this.group(group, indent)}`
  }

  private caseStatement(node: TSNodeLike, indent: string): string {
    const itemIndent = indent + INDENT
    const bodyIndent = itemIndent + INDENT
    let out = `case ${this.word(node.namedChildren[0] ?? node)} in \n`
    const items = node.namedChildren.filter((c) => c.type === NT.CASE_ITEM)
    getCaseItems(node).forEach(([patterns, body], index) => {
      const item = items[index]
      const text = this.statements(body, bodyIndent, false)
      out +=
        `${itemIndent}${patterns.map((p) => this.word(p)).join(' | ')})\n` +
        `${text === '' ? '' : bodyIndent + text}\n` +
        `${itemIndent}${item === undefined ? ';;' : terminator(node, item)}\n`
    })
    return `${out}${indent}esac`
  }

  redirects(nodes: readonly TSNodeLike[]): string {
    return nodes
      .filter((n) => REDIRECT_NODE_TYPES.has(n.type))
      .map((n) => ` ${this.redirect(n)}`)
      .join('')
  }

  /**
   * A redirect as bash respells it: a duplication or a close names its
   * descriptor (`1>&2`), a file one only a descriptor other than the
   * operator's own (`> f`, `2> f`), and a heredoc's body waits for the end of
   * the line.
   */
  redirect(node: TSNodeLike): string {
    const fdNode = node.children.find((c) => c.type === NT.FILE_DESCRIPTOR)
    const fd = fdNode === undefined ? null : getText(fdNode)
    if (node.heredoc !== undefined || node.type === NT.HEREDOC_REDIRECT)
      return this.heredoc(node, fd, node.heredoc)
    const text = getText(node)
    const opNode = node.children.find((c) => c.isNamed !== true && c.type !== '(' && c.type !== ')')
    const op = opNode === undefined ? '' : getText(opNode)
    const target = node.namedChildren.find((c) => c.type !== NT.FILE_DESCRIPTOR)
    const word = target === undefined ? '' : this.word(target)
    if (text.replace(/^\d+/, '').startsWith('<<<')) return `${fd ?? ''}<<< ${word}`
    if (op === '>&' || op === '<&' || op === '>&-' || op === '<&-') {
      if (target !== undefined && target.type !== NT.NUMBER && op === '>&') return `&> ${word}`
      return `${fd ?? (op.startsWith('>') ? '1' : '0')}${op}${word}`
    }
    if (op === '<>') return `${fd ?? '0'}<> ${word}`
    if (op === '&>' || op === '&>>') return `${op} ${word}`
    const fallback = op === '<' ? '0' : '1'
    const value = fd?.replace(/^0+(?=\d)/, '') ?? null
    const shown = value !== null && value !== fallback ? (fd ?? '') : ''
    return `${shown}${op} ${word}`
  }

  private heredoc(node: TSNodeLike, fd: string | null, document: Heredoc | undefined): string {
    const text = node.sourceText ?? node.text
    const operator = text.startsWith('<<-') ? '<<-' : '<<'
    let at = operator.length
    while (at < text.length && (text[at] === ' ' || text[at] === '\t')) at += 1
    const word = text.slice(at, delimiterEnd(text, at) ?? at)
    let body: string
    let delimiter: string
    let quoted: boolean
    if (document !== undefined) {
      body = document.body
      delimiter = document.delimiter
      quoted = document.quoted
    } else {
      body = getText(node.children.find((c) => c.type === 'heredoc_body') ?? node)
      delimiter = word.replace(/^['"]|['"]$/g, '')
      quoted = delimiter !== word
    }
    this.deferred.push(`${body}${delimiter}\n`)
    const shown = fd !== null && /[1-9]/.test(fd) ? fd : ''
    return shown + operator + (quoted ? singleQuote(delimiter) : word)
  }

  /**
   * A word as typed, but for what bash rewrites: `$'...'` decoded into single
   * quotes, `$"..."` as a plain string, a substitution's command printed
   * afresh, and a line continuation dropped.
   */
  word(node: TSNodeLike): string {
    const kind = node.type
    const text = getText(node)
    if (kind === NT.ANSI_C_STRING) return singleQuote(decodeAnsiC(text.slice(2, -1)))
    if (kind === 'translated_string') return text.slice(1)
    if (kind === NT.COMMAND_SUBSTITUTION && text.startsWith('$(')) {
      const inner = node.children.filter((c) => c.type !== '$(' && c.type !== ')')
      return `$(${new Printer(false).statements(inner, '', false)})`
    }
    if (node.children.length === 0) return stripContinuations(text)
    let out = ''
    for (const part of parts(node)) {
      out += typeof part === 'string' ? stripContinuations(part) : this.word(part)
    }
    return out
  }
}

function newlineBetween(left: TSNodeLike, right: TSNodeLike): boolean {
  const parent = left.parent ?? null
  if (parent === null) return false
  const between = parent.text.slice(end(left) - start(parent), start(right) - start(parent))
  return between.includes('\n') && !between.includes(';')
}

// As typed: the parser spells a last arm's `;;&` as `;;`.
function terminator(caseNode: TSNodeLike, item: TSNodeLike): string {
  const token = item.children.find((c) => c.type === ';;' || c.type === ';&' || c.type === ';;&')
  if (token === undefined) return ';;'
  const text = getText(token)
  const after = caseNode.text.slice(end(token) - start(caseNode))[0]
  return text === ';;' && after === '&' ? ';;&' : text
}

function parts(node: TSNodeLike): (string | TSNodeLike)[] {
  const source = node.text
  const base = start(node)
  let at = base
  const out: (string | TSNodeLike)[] = []
  for (const child of node.children) {
    if (start(child) > at) out.push(source.slice(at - base, start(child) - base))
    at = end(child)
    out.push(child)
  }
  if (at < end(node)) out.push(source.slice(at - base))
  return out
}
