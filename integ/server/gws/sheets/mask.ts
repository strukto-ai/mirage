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

import type { JsonValue } from '../../kit/typescript/index.ts'
import { isObj } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'
import { COLOR, isMessage } from './fields.ts'
import type { Field, Fields } from './fields.ts'

// One FieldMask path, a segment per message level. `['*']` is the whole
// message.
export type MaskPath = readonly string[]

// `a.b(c,d.e),f` read the way the live API reads it: a parenthesized list
// distributes over the path before it, so this is a.b.c, a.b.d.e and f. In
// a `read` mask (the `fields` of a GET) a partial-response `/` separates
// segments as `.` does (`sheets/properties`); a write mask is a FieldMask,
// where `/` is no separator, so it stays in the name and fails the check.
export function parseMask(text: string, read = false): MaskPath[] {
  let at = 0
  const items = (prefix: readonly string[]): MaskPath[] => {
    const out: MaskPath[] = []
    for (;;) {
      const path = [...prefix]
      let name = ''
      while (at < text.length && !',()'.includes(text.charAt(at))) {
        const ch = text.charAt(at)
        at += 1
        if (ch !== '.' && !(read && ch === '/')) name += ch
        else {
          path.push(name.trim())
          name = ''
        }
      }
      if (name.trim() !== '') path.push(name.trim())
      if (text.charAt(at) === '(') {
        at += 1
        out.push(...items(path))
        if (text.charAt(at) === ')') at += 1
      } else if (path.length > prefix.length) out.push(path)
      if (text.charAt(at) !== ',') return out
      at += 1
    }
  }
  return items([])
}

export function isWhole(paths: readonly MaskPath[]): boolean {
  return paths.some((path) => path.length === 1 && path[0] === '*')
}

// A read under a `fields` mask, trimmed the way the live API trims it: each
// path keeps what the resource holds there, through every element of a
// repeated field, `*` keeps the message whole, and the fields that stay keep
// the resource's own order.
export function pickMask(value: JsonValue, paths: readonly MaskPath[]): JsonValue {
  if (isWhole(paths)) return value
  if (Array.isArray(value)) return value.map((item) => pickMask(item, paths))
  if (!isObj(value)) return value
  const tails = new Map<string, MaskPath[]>()
  for (const [head = '', ...rest] of paths) tails.set(head, [...(tails.get(head) ?? []), rest])
  const out: JsonObj = {}
  for (const [key, field] of Object.entries(value)) {
    const under = tails.get(key)
    if (under === undefined) continue
    out[key] = under.some((rest) => rest.length === 0) ? field : pickMask(field, under)
  }
  return out
}

// The path live Sheets names when a mask reaches a field the message does
// not have: the valid part as typed, then the first bad segment in
// snake_case, and nothing after it (`textFormatX.bold` is `text_format_x`).
// A `read` mask (the `fields` of a GET) reaches through a repeated field to
// its elements, keeps a whole message at a `*`, and takes any path below a
// scalar or a message the tree leaves out.
export function badField(paths: readonly MaskPath[], fields: Fields, read = false): string | null {
  for (const path of paths) {
    if (path.length === 1 && path[0] === '*') continue
    let node: Field = fields
    for (let i = 0; i < path.length; i += 1) {
      const seg = path[i] ?? ''
      if (read && (node === null || seg === '*')) break
      const found: Field | undefined = isMessage(node) ? fieldOf(node, seg) : undefined
      const child: Field | undefined =
        read && found != null && !isMessage(found)
          ? 'list' in found
            ? found.list
            : found.map
          : found
      if (child === undefined) {
        const snake = seg.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
        return [...path.slice(0, i), snake].join('.')
      }
      node = child
    }
  }
  return null
}

// `target` after a masked write from `source`: each path takes what `source`
// holds there, or loses it when `source` holds nothing there, and `*` takes
// `source` whole. A Color and its `...Style` twin are one value on the live
// API, so writing either drops the other, which `canonical` rebuilds from
// the one written.
export function applyMask(
  target: JsonObj,
  source: JsonObj,
  paths: readonly MaskPath[],
  fields: Fields,
): JsonObj {
  if (isWhole(paths)) return structuredClone(source)
  const out = structuredClone(target)
  for (const path of paths) write(out, source, path, fields)
  return out
}

function write(target: JsonObj, source: JsonObj | undefined, path: MaskPath, fields: Fields): void {
  const [head = '', ...rest] = path
  const twin = twinOf(fields, head)
  if (twin !== undefined) delete target[twin]
  const from = source?.[head]
  const child = fieldOf(fields, head)
  if (rest.length === 0 || !isMessage(child)) {
    if (from === undefined) delete target[head]
    else target[head] = structuredClone(from)
    return
  }
  const inner = isObj(target[head]) ? target[head] : {}
  write(inner, isObj(from) ? from : undefined, rest, child)
  if (Object.keys(inner).length > 0) target[head] = inner
  else delete target[head]
}

function fieldOf(fields: Fields, name: string): Field | undefined {
  return fields.find(([key]) => key === name)?.[1]
}

function twinOf(fields: Fields, key: string): string | undefined {
  if (key.endsWith('Style')) {
    const base = key.slice(0, -'Style'.length)
    return fieldOf(fields, base) === COLOR ? base : undefined
  }
  return fieldOf(fields, key) === COLOR && fieldOf(fields, `${key}Style`) !== undefined
    ? `${key}Style`
    : undefined
}
