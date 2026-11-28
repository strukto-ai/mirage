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

// Plain-text rendering adapted from tvly 1.0.2's src/ui/text.ts and
// src/ui/render/ (MIT; see licenses/third_party/tavily-cli.txt): the output
// tvly prints when stdout is not a terminal, which an agent's shell never is.

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g
const BLANK_RUNS = /\n(?:[ \t]*\n){2,}/g
const JS_SPACE = '\\s'
const SPACE_RUN = new RegExp(`[${JS_SPACE}]+`)
const EDGE_SPACE = new RegExp(`^[${JS_SPACE}]+|[${JS_SPACE}]+$`, 'g')

/** `String(value)`: the python twin spells it out. */
export function jsText(value: unknown): string {
  return String(value)
}

/** Whether JavaScript reads `value` as true. */
export function truthy(value: unknown): boolean {
  return Boolean(value)
}

/** `String.prototype.trim`. */
export function jsTrim(text: string): string {
  return text.replace(EDGE_SPACE, '')
}

/** `text.slice(0, units)`, counted in UTF-16 code units as JavaScript counts. */
export function utf16Slice(text: string, units: number): string {
  return text.slice(0, units)
}

/** `text.length`: UTF-16 code units. */
export function utf16Length(text: string): number {
  return text.length
}

/** Drop C0 controls but tab, newline and return, plus DEL and C1. */
export function sanitizeControl(value: unknown): string {
  return jsText(value).replace(CONTROL_CHARS, '')
}

/** Sanitized, blank-line runs folded to one, trimmed. */
export function plain(value: unknown): string {
  return jsTrim(sanitizeControl(value).replace(BLANK_RUNS, '\n\n'))
}

/** Content on one line, cut at `maxChars` with an ellipsis; 0 keeps all. */
export function snippet(content: unknown, maxChars: number): string {
  const text = sanitizeControl(content)
    .split(SPACE_RUN)
    .filter((part) => part !== '')
    .join(' ')
  return maxChars && utf16Length(text) > maxChars ? `${utf16Slice(text, maxChars)}...` : text
}

/** The value when it is a list, else nothing. */
export function items(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : []
}

/** `value[name]`, undefined when `value` is no object or lacks it. */
export function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[name]
    : undefined
}

/** `String(value[name])`: `undefined` when the key is missing. */
export function memberText(value: unknown, name: string): string {
  return jsText(field(value, name))
}

/** `JSON.stringify(value)`, two-space indented when `pretty`. */
export function jsonText(value: unknown, pretty: boolean): string {
  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)
}

/** Each page as `# <url>`, a blank line, and its whole content. */
export function pagesText(pages: readonly unknown[]): string {
  let out = ''
  for (const page of pages) {
    const content = field(page, 'raw_content')
    out += `# ${plain(field(page, 'url') ?? '')}\n\n`
    out += `${plain(truthy(content) ? content : '(no content)')}\n\n`
  }
  return out
}
