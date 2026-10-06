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

import { expect, it } from 'vitest'
import { contains } from './pickaxe.ts'

// git 2.47 on debian:stable-slim lists a commit under -S PATTERN
// --pickaxe-regex when the count changes: a blank line counts, and ^ never
// holds where a search resumes after an empty match, so a third blank line in
// a row goes unseen.
it.each<[string, string, string, boolean]>([
  ['a\n', 'a\n\nb\n', '^$', true],
  ['a\n\nb\n', 'a\n\nc\n', '^$', false],
  ['a\n\nc\n', 'a\n\n\nc\n', '^$', false],
  ['a\n\n\nc\n', 'a\n\n\n\nc\n', '^$', true],
  ['x', '', '$', true],
  ['ab\nab\n', 'ab\nab\nab', '^', false],
  ['ab\nab\n', 'ab\nab\nab', '$', true],
  ['a\n\nc\n', 'a\n\n\nc\n', 'b*', true],
])('counts %j to %j under %s as git does', (old, now, pattern, listed) => {
  const regex = new RegExp(pattern)
  expect(contains(old, regex) !== contains(now, regex)).toBe(listed)
})
