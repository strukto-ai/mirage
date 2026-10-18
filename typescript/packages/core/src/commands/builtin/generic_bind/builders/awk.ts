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

import { awkGeneric, servedHere } from '../../generic/awk.ts'
import type { Context, CommandFn } from '../../../config.ts'
import { splitAssignment } from '../../../../core/awk/index.ts'
import type { PathSpec } from '../../../../types.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles } from '../files.ts'

/**
 * Expand awk's file operands, keeping `var=value` ones in place: an
 * assignment operand names no file, so it is never globbed, and awk
 * assigns it when its input reaches it, between the files around it. An
 * operand another mount serves arrives expanded and is read through the
 * dispatcher, so it is left as it is too.
 */
async function resolveOperands(
  resolve: (paths: PathSpec[]) => Promise<PathSpec[]>,
  paths: readonly PathSpec[],
  ctx: Context,
): Promise<PathSpec[]> {
  const out: PathSpec[] = []
  let run: PathSpec[] = []
  for (const path of paths) {
    if (splitAssignment(path.rawPath) === null && servedHere(ctx, path)) {
      run.push(path)
      continue
    }
    if (run.length > 0) out.push(...(await resolve(run)))
    run = []
    out.push(path)
  }
  if (run.length > 0) out.push(...(await resolve(run)))
  return out
}

const awk: CommandFn = async (_accessor, paths, texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const resolve = (run: PathSpec[]): Promise<PathSpec[]> => files.resolveGlob(run)
  const resolved = await resolveOperands(resolve, paths, ctx)
  return awkGeneric(resolved, texts, ctx, files.readStream)
}

export const BUILDER: GenericCommand = {
  name: 'awk',
  write: true,
  read: true,
  fn: awk,
}
