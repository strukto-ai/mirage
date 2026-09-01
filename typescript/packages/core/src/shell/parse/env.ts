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

import type { TSNodeLike } from '../types.ts'
import { CD_ANCHORS, DECL_PRINTER_HEADS, IMPLICIT_HEAD_READS, NAMEREF_HEADS } from './constants.ts'
import {
  commandArgs,
  commandInvocations,
  literalText,
  sameNode,
  walkNamedOutsideDefs,
} from './names.ts'

interface DeclarationParts {
  head: string
  flags: string[]
  operands: TSNodeLike[]
}

function declarationParts(node: TSNodeLike): DeclarationParts {
  const first = node.children[0]
  const head = first !== undefined ? first.text : ''
  const flags: string[] = []
  const operands: TSNodeLike[] = []
  for (const child of node.children.slice(1)) {
    if (child.type === 'word') {
      if (child.text.startsWith('-')) flags.push(child.text)
      else operands.push(child)
    } else if (child.isNamed === true || node.namedChildren.some((n) => sameNode(n, child))) {
      operands.push(child)
    }
  }
  return { head, flags, operands }
}

function flagHas(flags: string[], letter: string): boolean {
  return flags.some(
    (flag) => flag.startsWith('-') && !flag.startsWith('--') && flag.slice(1).includes(letter),
  )
}

/**
 * Names an `env` invocation provably keeps from the environment it
 * hands on: null when it reads no existing name at all, else the set a
 * whole-environment read may skip.
 *
 * Scanned with the builtin's own option grammar: `--` ends the
 * options, `-u`/`--unset` consume a value (so `-u -i` unsets a
 * variable named `-i` rather than clearing) and add it to the
 * exclusions, the leading `NAME=VALUE` operands override and exclude
 * their names, and the first other operand ends the scan. `-i`,
 * `--ignore-environment` or the lone `-` empties the start entirely,
 * and an option the builtin refuses stops it from running at all; both
 * answer null. The scan is left to right like the builtin's, so
 * everything consumed before the first word no static read can spell
 * keeps its effect whatever that word turns out to be, and nothing
 * after it is claimed: a dynamic word may be the command, demoting
 * every later word to an argument.
 */
function envExclusions(args: TSNodeLike[]): ReadonlySet<string> | null {
  const excluded = new Set<string>()
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    const literal = arg === undefined ? null : literalText(arg)
    if (literal === null) return excluded
    if (literal === '--') {
      i += 1
      break
    }
    if (literal === '-i' || literal === '--ignore-environment' || literal === '-') return null
    if (literal === '--unset') {
      if (i + 1 >= args.length) return null
      const next = args[i + 1]
      const value = next === undefined ? null : literalText(next)
      if (value !== null) excluded.add(value)
      i += 2
      continue
    }
    if (literal.startsWith('--unset=')) {
      excluded.add(literal.slice('--unset='.length))
      i += 1
      continue
    }
    if (literal === '-0' || literal === '--null') {
      i += 1
      continue
    }
    if (literal.startsWith('--')) return null
    if (literal.startsWith('-') && literal.length > 1) {
      let step = 1
      let bad = false
      for (let pos = 1; pos < literal.length; pos += 1) {
        const ch = literal[pos]
        if (ch === 'i') return null
        if (ch === 'u') {
          const rest = literal.slice(pos + 1)
          if (rest !== '') {
            excluded.add(rest)
          } else if (i + 1 < args.length) {
            const next = args[i + 1]
            const value = next === undefined ? null : literalText(next)
            if (value !== null) excluded.add(value)
            step = 2
          } else {
            return null
          }
          break
        }
        if (ch !== '0') {
          bad = true
          break
        }
      }
      if (bad) return null
      i += step
      continue
    }
    break
  }
  while (i < args.length) {
    const arg = args[i]
    const literal = arg === undefined ? null : literalText(arg)
    if (literal === null) return excluded
    if (!literal.includes('=') || literal.startsWith('=')) break
    excluded.add(literal.split('=', 1)[0] ?? '')
    i += 1
  }
  return excluded
}

/**
 * Names a command's assignment prefixes provably override.
 *
 * `TOKEN=local printenv TOKEN` hands the command an environment whose
 * TOKEN is the override, so an environment read through that
 * invocation cannot observe the standing value whatever the override
 * expands to; the value's own reads are the walk's business. `+=`
 * appends to the standing value and proves nothing.
 */
function prefixAssignmentNames(node: TSNodeLike): Set<string> {
  const out = new Set<string>()
  for (const child of node.namedChildren) {
    if (child.type !== 'variable_assignment') continue
    if (child.children.some((part) => part.type === '+=')) continue
    const nameNode = child.childForFieldName?.('name') ?? null
    if (nameNode?.type !== 'variable_name') continue
    if (nameNode.text !== '') out.add(nameNode.text)
  }
  return out
}

/**
 * How the line's environment-rendering commands read names.
 *
 * Returns `{whole, names, excluded}`: whether some command renders the
 * whole environment, the names printing forms read explicitly, and the
 * names every whole-environment read provably skips. Only a printing
 * form selects everything: `env` on any invocation (bare it prints
 * every exported name, and with arguments it hands the snapshot to the
 * command it runs) unless a literal `-i`, `--ignore-environment` or
 * lone `-` proves it starts empty, a bare `set`, a bare `printenv`,
 * and a declaring builtin with no operands (`export`, `declare -p`).
 * `printenv NAME` and `declare -p NAME` read exactly the named
 * variables, and a mutating form (`export NAME=v`, `declare -x NAME`,
 * `set -u`) reads nothing here, so an unavailable source cannot fail
 * the write that would replace its pointer. A print target no static
 * read can spell (`printenv $x`) falls back to the whole environment.
 *
 * Exclusions are per invocation: an assignment prefix overrides its
 * name for exactly that command's environment, and `env`'s `-u`,
 * `--unset` and `NAME=VALUE` words remove or override theirs
 * (`envExclusions`), so `env -u TOKEN printenv TOKEN` cannot observe
 * TOKEN however the whole snapshot is handed on. A print target so
 * excluded is dropped rather than reported. `excluded` is the
 * intersection across the node's whole-environment reads, because a
 * name is skippable only when every such read skips it.
 */
export function envReads(node: TSNodeLike): {
  whole: boolean
  names: ReadonlySet<string>
  excluded: ReadonlySet<string>
} {
  let whole = false
  let excluded: ReadonlySet<string> | null = null
  const names = new Set<string>()
  for (const current of walkNamedOutsideDefs(node)) {
    if (current.type === 'command') {
      const nameNode = current.childForFieldName?.('name') ?? null
      const head = nameNode !== null ? nameNode.text : ''
      const prefix = prefixAssignmentNames(current)
      let skipped: ReadonlySet<string> | null = null
      if (head === 'env') {
        const scanned = envExclusions(commandArgs(current))
        if (scanned !== null) skipped = new Set([...prefix, ...scanned])
      } else if (head === 'set') {
        if (commandArgs(current).length === 0) skipped = prefix
      } else if (head === 'printenv') {
        let readAny = false
        for (const child of commandArgs(current)) {
          const literal = literalText(child)
          if (literal === null) {
            skipped = prefix
            readAny = true
          } else if (!literal.startsWith('-')) {
            if (!prefix.has(literal)) names.add(literal)
            readAny = true
          }
        }
        if (!readAny) skipped = prefix
      }
      if (skipped !== null) {
        whole = true
        const skip = skipped
        const prior: ReadonlySet<string> | null = excluded
        // The parameter annotation breaks tsc's circular inference:
        // `excluded` is assigned from an arrow whose context is itself.
        excluded =
          prior === null ? skip : new Set([...prior].filter((name: string) => skip.has(name)))
      }
    } else if (current.type === 'declaration_command') {
      const { head, flags, operands } = declarationParts(current)
      if (!DECL_PRINTER_HEADS.has(head)) continue
      let selected = false
      if (operands.length === 0) {
        selected = true
      } else if (flagHas(flags, 'p')) {
        for (const operand of operands) {
          if (operand.type === 'variable_name') {
            if (operand.text !== '') names.add(operand.text)
          } else if (operand.type !== 'variable_assignment') {
            selected = true
          }
        }
      }
      if (selected) {
        whole = true
        excluded = new Set()
      }
    }
  }
  return { whole, names, excluded: excluded ?? new Set() }
}

/**
 * Whether the line reads names no static walk can spell.
 *
 * Two constructs defeat `referencedNames`: an indirect expansion
 * (`${!name}` reads the variable the *value* of `name` names, and the
 * `${!p*}`/`${!p@}` forms enumerate by prefix), and a nameref declared
 * on the line itself (`declare -n r=T; echo $r` reads T before any
 * session record says so). A nameref from an earlier line is not
 * opaque: the session records its target, which `deref` resolves.
 */
export function opaqueReads(node: TSNodeLike): boolean {
  for (const current of walkNamedOutsideDefs(node)) {
    if (current.type === 'expansion' && current.children.some((c) => c.type === '!')) {
      return true
    }
    if (current.type === 'declaration_command') {
      const { head, flags } = declarationParts(current)
      if (NAMEREF_HEADS.has(head) && flagHas(flags, 'n')) return true
    }
  }
  return false
}

/**
 * The names one `cd` invocation reads implicitly.
 *
 * Bare `cd` goes to `$HOME`, `cd -` to `$OLDPWD`, and a searchable
 * relative operand tries `$CDPATH` first. Option words (`-L`/`-P`/
 * `--`) are not operands, and a word no static read can spell may
 * expand to any of the shapes, so it selects all three.
 */
function cdReads(args: (string | null)[]): ReadonlySet<string> {
  const operands: string[] = []
  for (const arg of args) {
    if (arg === null) return new Set(['HOME', 'OLDPWD', 'CDPATH'])
    if (arg === '-' || !arg.startsWith('-')) operands.push(arg)
  }
  const target = operands[0]
  if (target === undefined) return new Set(['HOME'])
  if (target === '-') return new Set(['OLDPWD'])
  if (CD_ANCHORS.some((anchor) => target.startsWith(anchor)) || target === '.' || target === '..') {
    return new Set()
  }
  return new Set(['CDPATH'])
}

/**
 * Names the program reads without a `$NAME` in the text.
 *
 * Tilde expansion resolves `~` and `~/...` against `$HOME` wherever a
 * word expands (patterns and redirect targets included), and the word
 * scan mirrors the expansion exactly: `~user`, a mid-word tilde and a
 * quoted one stay literal. `cd` reads `$HOME` bare, `$OLDPWD` for `-`
 * and `$CDPATH` for a searchable relative operand; `read` splits on
 * `$IFS`; `getopts` resumes from `$OPTIND` and consults `$OPTERR`.
 * These join the fill plan exactly as a spelled reference does, so a
 * managed `HOME` fetches for `echo ~` the way it does for `echo $HOME`.
 */
export function implicitReads(node: TSNodeLike): ReadonlySet<string> {
  const out = new Set<string>()
  for (const current of walkNamedOutsideDefs(node)) {
    if (current.type === 'word' && (current.text === '~' || current.text.startsWith('~/'))) {
      out.add('HOME')
    }
  }
  for (const [head, args] of commandInvocations(node)) {
    const reads = head === null ? undefined : IMPLICIT_HEAD_READS.get(head)
    if (reads !== undefined) for (const name of reads) out.add(name)
    if (head === 'cd') for (const name of cdReads(args)) out.add(name)
  }
  return out
}
