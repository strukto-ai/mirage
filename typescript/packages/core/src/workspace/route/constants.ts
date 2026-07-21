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

import { ShellBuiltin } from '../../shell/types.ts'

// Bash builtins the parser accepts but the executor cannot honor; they
// still route to the shell layer so the error names a capability gap.
export const UNSUPPORTED_BUILTINS: ReadonlySet<string> = new Set([
  'bg',
  'disown',
  'exec',
  'complete',
  'compgen',
  'ulimit',
])

export const NAMESPACE_COMMANDS: ReadonlySet<string> = new Set(['ln', 'readlink'])

// ShellBuiltin subset handled through the job table in the executor.
export const JOB_BUILTINS: ReadonlySet<string> = new Set(['wait', 'fg', 'kill', 'jobs', 'ps'])

// Commands with lstat semantics: they act on the symlink entry itself,
// so dispatch must not rewrite their operands through the link table.
export const NO_FOLLOW_COMMANDS: ReadonlySet<string> = new Set([
  'rm',
  'mv',
  'ln',
  'readlink',
  'rmdir',
  'unlink',
])

export const SHELL_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(ShellBuiltin),
  ...UNSUPPORTED_BUILTINS,
])
