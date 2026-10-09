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

// Apply `fn` to each line of `text`, keeping its line ends. A GNU line
// filter (rev, fold) writes a newline where its input had one and nowhere
// else, so a last line with none ends the output without one too: `rev` of
// `ab` is `ba`. It runs per file, so a second file starts from a fresh line
// of its own. Mirrors Python's map_lines.
export function mapLines(text: string, fn: (line: string) => string): string {
  const out = splitLines(text).map(fn).join('\n')
  return text.endsWith('\n') ? `${out}\n` : out
}

// joinFileLines for readers that keep raw bytes (column). Mirrors Python's
// join_file_lines over bytes.
export function joinFileBytes(chunks: readonly Uint8Array[], sep: number): Uint8Array {
  const parts: Uint8Array[] = []
  chunks.forEach((chunk, index) => {
    parts.push(chunk)
    const last = chunk[chunk.byteLength - 1]
    if (index < chunks.length - 1 && chunk.byteLength > 0 && last !== sep) {
      parts.push(Uint8Array.of(sep))
    }
  })
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}
