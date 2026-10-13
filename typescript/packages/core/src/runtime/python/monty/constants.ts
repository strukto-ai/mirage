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

import type { FsCondition } from '../../../errors/index.ts'

export const MISSING_PACKAGE_HINT =
  "monty runtime requires the '@pydantic/monty' package — install it or select the pyodide runtime"

// argv[0] when the caller named no program of its own.
export const DEFAULT_PROG = 'main.py'
export const MAX_URANDOM_BYTES = 1_048_576

// Monty ends a session past this many host round trips, and every file
// call is one or two, so its default of 1000 stopped a loop of 500 reads.
// The count cannot be turned off, so a checkout sets it past what any run
// reaches; the command limits bound a run instead.
export const LIMITS = { maxSuspensions: 2 ** 31 - 1 }

// A console tells "keep typing" from "this is broken" by matching
// monty's own traceback wording, so a version that rephrases either
// line turns every continuation into an error at the prompt.
export const INCOMPLETE_MARKERS = ['unexpected EOF', 'Expected an indented block'] as const

/**
 * What a refused readlink may mean "no link here". EINVAL is the backend
 * saying the path is not one, and the other three are CPython's own
 * `_ignore_error` list, which is what `Path.is_symlink` swallows around
 * its lstat. Everything else propagates: CPython re-raises
 * PermissionError out of `is_symlink`, and reporting a refusal as "not a
 * link" is an answer the guest cannot tell from one.
 */
export const NOT_A_LINK: ReadonlySet<FsCondition> = new Set<FsCondition>([
  'EINVAL',
  'ENOENT',
  'ENOTDIR',
  'ELOOP',
])
