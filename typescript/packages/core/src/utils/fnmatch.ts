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

// Port of CPython fnmatch.translate matching semantics. Deliberate divergences:
// always case-sensitive (no normcase, so this equals Python fnmatchcase), an
// invalid class range like [z-a] becomes the never-matching (?!) instead of
// raising, and a leading ^ negates a class like ! does (bash/glibc semantics;
// CPython keeps ^ literal). Mirrors the Python mirage.utils.fnmatch wrapper.
export function fnmatch(name: string, pattern: string): boolean {
  return translate(pattern).test(name)
}

function classBody(stuff: string): string {
  let body = stuff.replace(/\\/g, '\\\\').replace(/\]/g, '\\]').replace(/\[/g, '\\[')
  if (body.startsWith('!')) body = '^' + body.slice(1)
  else if (body.startsWith('^')) body = '^' + body.slice(1)
  try {
    new RegExp('[' + body + ']')
  } catch {
    return '(?!)'
  }
  return '[' + body + ']'
}

function translate(pattern: string): RegExp {
  let re = ''
  let i = 0
  const n = pattern.length
  while (i < n) {
    const c = pattern[i]
    if (c === undefined) break
    i += 1
    if (c === '*') {
      if (!re.endsWith('.*')) re += '.*'
    } else if (c === '?') {
      re += '.'
    } else if (c === '[') {
      let j = i
      if (j < n && (pattern[j] === '!' || pattern[j] === '^')) j += 1
      if (j < n && pattern[j] === ']') j += 1
      while (j < n && pattern[j] !== ']') j += 1
      if (j >= n) {
        re += '\\['
      } else {
        const stuff = pattern.slice(i, j)
        i = j + 1
        if (stuff === '!' || stuff === '^') re += '.'
        else re += classBody(stuff)
      }
    } else if (/[.+^$(){}|[\]\\/]/.test(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^(?:' + re + ')$', 's')
}
