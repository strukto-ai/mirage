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

export const EXECUTE_DESCRIPTION =
  'Run a shell-style command on the Mirage virtual filesystem. ' +
  'Supports cat, grep, find, head, tail, ls, wc, sort, uniq, tee, pipe, ' +
  'and any other Unix command on mounted resources (S3, disk, RAM, etc.). ' +
  'Also supports reading structured files: cat on .parquet/.orc/.csv returns a table.'

export const READ_DESCRIPTION =
  'Read the contents of a file on the Mirage virtual filesystem. ' +
  'Returns line-numbered text. ' +
  "Optionally pass 'offset' (default 0) to start at a given line " +
  "and 'limit' (default 2000) to cap the number of lines returned."

export const WRITE_DESCRIPTION =
  'Write content to a new file on the Mirage virtual filesystem. ' +
  'Fails if the file already exists; use edit to modify an existing file.'

export const EDIT_DESCRIPTION =
  'Replace a string in an existing file on the Mirage virtual filesystem. ' +
  'Fails if the file changed since it was last read, old_string is not found, ' +
  'or old_string appears more than once. ' +
  'Pass replace_all=true (default false) to replace every occurrence.'

export const LS_DESCRIPTION =
  'List files and directories at the given path on the Mirage virtual filesystem.'

export const GREP_DESCRIPTION =
  'Search for a pattern in files on the Mirage virtual filesystem. ' +
  'Supports regex. Searches recursively under path.'
