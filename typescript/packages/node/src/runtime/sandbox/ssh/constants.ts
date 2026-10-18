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

import { singleQuote } from '@struktoai/mirage-core/utils/quote'

/**
 * The line dressed to run on the remote host: cwd, env, then sh.
 *
 * SSH exec has no docker-style `-w`/`-e` (the protocol's env channel
 * is AcceptEnv-gated server-side, so it silently drops names), so the
 * working directory and the merged environment ride the command
 * itself: `cd 'cwd' && env 'K=V' ... sh -c 'line'`. Every piece is
 * single-quoted for sh, so the remote login shell reads each as one word
 * whatever it holds; the machine only needs a POSIX-compatible shell.
 */
export function wrapLine(line: string, env: Record<string, string>, cwd: string): string {
  const parts = ['cd', singleQuote(cwd), '&&', 'env']
  for (const [key, value] of Object.entries(env)) parts.push(singleQuote(`${key}=${value}`))
  parts.push('sh', '-c', singleQuote(line))
  return parts.join(' ')
}
