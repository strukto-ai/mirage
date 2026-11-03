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
import { GITLINK_MODE, REGULAR_MODE, SYMLINK_MODE } from './constants.ts'
import { validPath } from './tree.ts'

const FILE = REGULAR_MODE
const LINK = SYMLINK_MODE

it.each([
  ['a.txt', FILE, true],
  ['docs/readme.md', FILE, true],
  ['.gitignore', FILE, true],
  ['a.git/x', FILE, true],
  ['sub/.gitx', FILE, true],
  ['..a/b', FILE, true],
  ['../a', FILE, false],
  ['a/..', FILE, false],
  ['./a', FILE, false],
  ['a/./b', FILE, false],
  ['a//b', FILE, false],
  ['', FILE, false],
  ['.git', FILE, false],
  ['.GIT/config', FILE, false],
  ['sub/.Git/hooks/x', FILE, false],
  ['.git.', FILE, false],
  ['.git /x', FILE, false],
  ['.GIT. /x', FILE, false],
  ['git~1', FILE, false],
  ['GIT~1/x', FILE, false],
  ['git~1../x', FILE, false],
  ['.git::$INDEX_ALLOCATION/x', FILE, false],
  ['.git:x', FILE, false],
  ['.git:\nx', FILE, false],
  ['git~1:x', FILE, false],
  ['.git\\x', FILE, false],
  ['x\\.git/f', FILE, false],
  ['\\\\.git', FILE, false],
  ['.git\\', FILE, false],
  ['\\.git', FILE, true],
  ['d/\\.git/y', FILE, true],
  ['\\GIT~1', FILE, true],
  ['\\.git\\x', FILE, true],
  ['sub/.git.', FILE, false],
  ['git~2/x', FILE, true],
  ['git~10', FILE, true],
  ['.git.x', FILE, true],
  ['.git~1', FILE, true],
  [' .git', FILE, true],
  ['x.git.', FILE, true],
  ['a\\b', FILE, true],
  ['..\\x', FILE, true],
  ['a\\..', FILE, true],
  ['.g\u0131t', FILE, true],
  ['.gitmodules', FILE, true],
  ['gitmod~1', FILE, true],
  ['.gitmodules/b', FILE, true],
  ['.gitmodules', LINK, false],
  ['.GITMODULES.', LINK, false],
  ['.gitmodules::$DATA', LINK, false],
  ['sub/.gitmodules', LINK, false],
  ['gitmod~4', LINK, false],
  ['GI7EBA~9', LINK, false],
  ['gi7eb~12', LINK, false],
  ['g~123456', LINK, false],
  ['~1234567', LINK, false],
  ['GI7EB~12.', LINK, false],
  ['x\\.gitmodules', LINK, false],
  ['x\\\\gitmod~1', LINK, false],
  ['.gitmodules/b', LINK, false],
  ['.GITMODULES/b', LINK, false],
  ['.gitmodules:x/y', LINK, false],
  ['a/.gitmodules/x', LINK, false],
  ['gitmod~5', LINK, true],
  ['gi7eba~10', LINK, true],
  ['gi7eb~1', LINK, true],
  ['gi7eb~123', LINK, true],
  ['gi7eb~02', LINK, true],
  ['gx7eb~12', LINK, true],
  ['.gitmodules.x', LINK, true],
  ['.gitattributes', LINK, true],
  ['.gitmodule\u017f', LINK, true],
  ['.gitmodules\\x', LINK, true],
  ['\\.gitmodules', LINK, true],
  ['\\gi7eb~12', LINK, true],
  ['.gitmodules./b', LINK, true],
  ['gitmod~1/b', LINK, true],
  ['x\\.gitmodules/b', LINK, true],
  ['.gitmodules', '120644', false],
  ['.gitmodules', '120755', false],
  ['.gitmodules', '100755', true],
  ['.gitmodules', GITLINK_MODE, true],
  ['.gitmodules', '0120000', false],
])('treats %s (mode %s) as a path git checks out: %s', (path, mode, expected) => {
  expect(validPath(path, mode)).toBe(expected)
})
