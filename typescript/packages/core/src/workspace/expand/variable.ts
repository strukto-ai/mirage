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

import type { CallStack } from '../../shell/call_stack.ts'
import { NodeType as NT } from '../../shell/types.ts'
import type { Session } from '../session/session.ts'
import { homeDir } from '../session/shell_dirs.ts'
import { fnmatch } from '../../utils/fnmatch.ts'

export interface TSNodeLike {
  type: string
  text: string
  children: TSNodeLike[]
  namedChildren: TSNodeLike[]
  isNamed?: boolean
}

const PARAM_OPS: ReadonlySet<string> = new Set([
  ':-',
  '-',
  ':+',
  '+',
  ':?',
  '?',
  ':=',
  '=',
  '#',
  '##',
  '%',
  '%%',
  '/',
  '//',
  ':',
  '^',
  '^^',
  ',',
  ',,',
  '!',
])

export function lookupVar(name: string, session: Session, callStack: CallStack | null): string {
  const env = session.env
  const lastExitCode = session.lastExitCode
  const positional = session.positionalArgs
  if (name === '@' || name === '*') {
    if (callStack && callStack.getAllPositional().length > 0) {
      return callStack.getAllPositional().join(' ')
    }
    if (positional.length > 0) return positional.join(' ')
    return ''
  }
  if (name === '#') {
    if (callStack && callStack.getAllPositional().length > 0) {
      return String(callStack.getPositionalCount())
    }
    if (positional.length > 0) return String(positional.length)
    return '0'
  }
  if (name === '?') {
    return String(lastExitCode)
  }
  if (/^\d+$/.test(name)) {
    const idx = parseInt(name, 10)
    if (idx === 0) return 'mirage'
    if (callStack) {
      const fromCall = callStack.getPositional(idx)
      if (fromCall !== '') return fromCall
    }
    if (idx > 0 && idx <= positional.length) return positional[idx - 1] ?? ''
    return ''
  }
  if (callStack) {
    const localVal = callStack.getLocal(name)
    if (localVal !== null) return localVal
  }
  if (name === 'PWD') return session.cwd
  if (name === 'HOME') return homeDir(session) ?? ''
  return env[name] ?? ''
}

function globStrip(value: string, pattern: string, greedy: boolean, prefix: boolean): string {
  if (pattern === '') return value
  const matches: number[] = []
  if (prefix) {
    for (let i = 0; i <= value.length; i++) {
      if (fnmatch(value.slice(0, i), pattern)) matches.push(i)
    }
    if (matches.length === 0) return value
    const i = greedy ? Math.max(...matches) : Math.min(...matches)
    return value.slice(i)
  }
  for (let i = 0; i <= value.length; i++) {
    if (fnmatch(value.slice(i), pattern)) matches.push(i)
  }
  if (matches.length === 0) return value
  const i = greedy ? Math.min(...matches) : Math.max(...matches)
  return value.slice(0, i)
}

function applyOp(op: string, val: string, varInEnv: boolean, args: string[]): string {
  if (op === ':-') return val !== '' ? val : (args[0] ?? '')
  if (op === '-') {
    if (varInEnv) return val
    return args[0] ?? ''
  }
  if (op === ':+') return val !== '' ? (args[0] ?? '') : ''
  if (op === '+') return varInEnv ? (args[0] ?? '') : ''
  if (op === '#') return globStrip(val, args[0] ?? '', false, true)
  if (op === '##') return globStrip(val, args[0] ?? '', true, true)
  if (op === '%') return globStrip(val, args[0] ?? '', false, false)
  if (op === '%%') return globStrip(val, args[0] ?? '', true, false)
  if (op === '/') {
    if (args.length === 0) return val
    const replacement = args[1] ?? ''
    return val.replace(args[0] ?? '', replacement)
  }
  if (op === '//') {
    if (args.length === 0) return val
    const replacement = args[1] ?? ''
    return val.split(args[0] ?? '').join(replacement)
  }
  if (op === '^^') return val.toUpperCase()
  if (op === ',,') return val.toLowerCase()
  if (op === '^') return val.length > 0 ? (val[0] ?? '').toUpperCase() + val.slice(1) : val
  if (op === ',') return val.length > 0 ? (val[0] ?? '').toLowerCase() + val.slice(1) : val
  if (op === ':' && args.length > 0) {
    const offsetRaw = args[0] ?? ''
    const lengthRaw = args[1]
    const offsetParsed = parseInt(offsetRaw.trim(), 10)
    if (Number.isNaN(offsetParsed)) return val
    let offset = offsetParsed
    let length: number | null = null
    if (lengthRaw !== undefined) {
      const lengthParsed = parseInt(lengthRaw.trim(), 10)
      if (Number.isNaN(lengthParsed)) return val
      length = lengthParsed
    }
    if (offset < 0) offset = Math.max(0, val.length + offset)
    if (length === null) return val.slice(offset)
    if (length < 0) return val.slice(offset, Math.max(offset, val.length + length))
    return val.slice(offset, offset + length)
  }
  return val
}

export function expandBraces(
  node: TSNodeLike,
  env: Record<string, string>,
  callStack: CallStack | null,
  arrays: Record<string, string[]> = {},
): string {
  let varName: string | null = null
  let subscriptNode: TSNodeLike | null = null
  let lengthOp = false
  let indirectOp = false
  let op: string | null = null
  const args: string[] = []
  let seenVar = false

  for (const c of node.children) {
    if (c.type === '${' || c.type === '}') continue
    if (c.type === '#' && !seenVar) {
      lengthOp = true
      continue
    }
    if (c.type === '!' && !seenVar) {
      indirectOp = true
      continue
    }
    if (c.type === NT.VARIABLE_NAME) {
      varName = c.text
      seenVar = true
      continue
    }
    if (c.type === 'subscript') {
      subscriptNode = c
      for (const sc of c.namedChildren) {
        if (sc.type === NT.VARIABLE_NAME) {
          varName = sc.text
          break
        }
      }
      seenVar = true
      continue
    }
    if (PARAM_OPS.has(c.type) && op === null) {
      op = c.text
      continue
    }
    if (
      c.type === NT.WORD ||
      c.type === NT.STRING ||
      c.type === NT.RAW_STRING ||
      c.type === NT.STRING_CONTENT ||
      c.type === NT.NUMBER ||
      c.type === 'regex'
    ) {
      args.push(c.text)
    }
  }

  let val = ''
  let varInEnv = false

  if (subscriptNode !== null && varName !== null) {
    let idxText = ''
    for (const sc of subscriptNode.namedChildren) {
      if (sc.type === NT.VARIABLE_NAME) continue
      idxText = sc.text
      break
    }
    let arr = arrays[varName]
    if (arr === undefined) {
      const scalar = env[varName] ?? ''
      arr = scalar !== '' ? [scalar] : []
    }
    varInEnv = varName in arrays || varName in env
    if (idxText === '@' || idxText === '*') {
      if (lengthOp) return String(arr.length)
      val = arr.join(' ')
    } else {
      const i = parseInt(idxText, 10)
      if (Number.isFinite(i) && !Number.isNaN(i) && i >= 0 && i < arr.length) {
        val = arr[i] ?? ''
      } else {
        val = ''
      }
    }
  } else if (varName !== null) {
    if (callStack) {
      const localVal = callStack.getLocal(varName)
      if (localVal !== null) {
        val = localVal
        varInEnv = true
      }
    }
    if (!varInEnv) {
      varInEnv = varName in env
      val = env[varName] ?? ''
    }
  }

  if (indirectOp) {
    return val !== '' ? (env[val] ?? '') : ''
  }
  if (lengthOp) return String(val.length)
  if (op === null) return val
  return applyOp(op, val, varInEnv, args)
}
