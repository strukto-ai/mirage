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

export const SHELL_DESCRIPTION =
  'Run a shell command line on the Mirage virtual filesystem, in the ' +
  "session's working directory. Supports pipes, redirects, cat, grep, " +
  'find, head, tail, ls, wc, sort, uniq, tee and any other Unix command ' +
  'on mounts (S3, disk, RAM, etc.); a cd or export holds for the next ' +
  'call. Files with no registered renderer, such as .parquet or .orc, ' +
  'read back as raw bytes.'

export const READ_DESCRIPTION =
  'Read the contents of a file on the Mirage virtual filesystem. ' +
  'Returns line-numbered text. ' +
  "Optionally pass 'offset' (default 0) to start at a given line " +
  "and 'limit' (default 2000) to cap the number of lines returned."

export const WRITE_DESCRIPTION =
  'Write a file on the Mirage virtual filesystem, creating missing parent ' +
  'directories. An existing file must be read in full first, and the write fails ' +
  'if it changed since; use edit to change part of a file.'

export const EDIT_DESCRIPTION =
  'Replace a string in an existing file on the Mirage virtual filesystem. ' +
  'Fails if the file changed since it was last read, old_string is not ' +
  'found, or old_string appears more than once. ' +
  'Pass replace_all=true (default false) to replace every occurrence.'

export const LS_DESCRIPTION =
  'List files and directories at the given path on the Mirage virtual filesystem.'

export const GREP_DESCRIPTION =
  'Search files on the Mirage virtual filesystem for a regular ' +
  'expression, recursively under path, as GNU grep -rn does. Prints ' +
  'file:line:text for each match. Finding nothing is not an error.'

export const GLOB_DESCRIPTION =
  'Find files on the Mirage virtual filesystem whose path matches a ' +
  'pattern such as **/*.py, where ** matches any number of directories. ' +
  'Returns one path per line, sorted.'

export const SHELL_INPUT = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'The command line to run.',
    },
  },
  required: ['command'],
} as const

export const READ_INPUT = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Absolute path of the file to read.',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      description: 'First line to return, zero-based (default 0).',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      description: 'Maximum number of lines to return (default 2000).',
    },
  },
  required: ['path'],
} as const

export const WRITE_INPUT = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Absolute path of the file to write.',
    },
    content: {
      type: 'string',
      description: 'The text to write.',
    },
  },
  required: ['path', 'content'],
} as const

export const EDIT_INPUT = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Absolute path of the file to edit.',
    },
    old_string: {
      type: 'string',
      description: 'The exact text to replace.',
    },
    new_string: {
      type: 'string',
      description: 'The text to put in its place.',
    },
    replace_all: {
      type: 'boolean',
      description: 'Replace every occurrence instead of exactly one (default false).',
    },
  },
  required: ['path', 'old_string', 'new_string'],
} as const

export const LS_INPUT = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Absolute path of the directory to list.',
    },
  },
  required: ['path'],
} as const

export const GREP_INPUT = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description: 'Regular expression to search for.',
    },
    path: {
      type: 'string',
      description: 'Absolute path of the file or directory to search under.',
    },
    ignore_case: {
      type: 'boolean',
      description: 'Match case-insensitively (-i).',
    },
    fixed_strings: {
      type: 'boolean',
      description: 'Read pattern as a literal string, not a regex (-F).',
    },
    include: {
      type: 'string',
      description: 'Search only files whose name matches this glob, such as *.py (--include).',
    },
    context: {
      type: 'integer',
      minimum: 0,
      description: 'Lines of context to print around each match (-C).',
    },
    files_with_matches: {
      type: 'boolean',
      description: 'Print only the names of files that match (-l).',
    },
    count: {
      type: 'boolean',
      description: 'Print only a count of matching lines per file (-c).',
    },
    max_count: {
      type: 'integer',
      minimum: 1,
      description: 'Stop each file after this many matching lines (-m).',
    },
  },
  required: ['pattern', 'path'],
} as const

export const GLOB_INPUT = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description:
        'Pathname pattern such as **/*.py or src/*.ts; a relative one is matched under path.',
    },
    path: {
      type: 'string',
      description:
        'Absolute path of the directory a relative pattern is matched under (default /).',
    },
  },
  required: ['pattern'],
} as const
