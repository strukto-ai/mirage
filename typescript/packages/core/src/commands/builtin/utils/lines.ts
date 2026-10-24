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

// Split text into lines (or `sep`-terminated records), dropping the
// terminator's trailing empty entry. Mirrors Python's
// mirage.commands.builtin.utils.lines.split_lines.
// The byte that ends a record: NUL under -z, else a newline.
export function recordSeparator(zero: boolean): number {
  return zero ? 0 : 0x0a
}

export function splitLines(text: string, sep = '\n'): string[] {
  if (text === '') return []
  const stripped = text.endsWith(sep) ? text.slice(0, -sep.length) : text
  return stripped.split(sep)
}

// Split text into newline-terminated lines, each keeping its newline; a
// last line with none is kept as it is. Mirrors Python's split_lines_keepends.
export function splitLinesKeepends(text: string): string[] {
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lines.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}
