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

import { PathSpec } from '../../../../types.ts'
import { mountKey } from '../../../../utils/key_prefix.ts'
import { mktempGeneric } from '../../generic/mktemp.ts'
import { pathExists } from '../../utils/copy.ts'
import { requireOp, type GenericCommand, type GenericCommandFn } from '../adapter.ts'

const mktemp: GenericCommandFn = (ops, accessor, _paths, texts, opts) => {
  // The name a pathless mktemp creates is under $TMPDIR or /tmp, which the
  // working directory's mount rarely owns, so the create goes through the
  // dispatcher to whichever mount does. Only a generic run outside a
  // workspace, with no dispatcher and no other mount, writes through this
  // mount's own ops. Mirrors Python's builder.
  const mkdir = requireOp(ops.mkdir, 'mkdir')
  const write = requireOp(ops.write, 'write')
  const local = (p: PathSpec): PathSpec =>
    PathSpec.fromStrPath(p.virtual, mountKey(p.virtual, opts.mountPrefix ?? ''))
  return mktempGeneric(
    texts,
    opts,
    async (p) => {
      if (opts.dispatch !== undefined) await opts.dispatch('mkdir', p, [], { parents: false })
      else await mkdir(accessor, local(p))
    },
    async (p, d) => {
      if (opts.dispatch !== undefined) await opts.dispatch('write', p, [d])
      else await write(accessor, local(p), d)
    },
    async (p) => {
      if (opts.statPath !== undefined) return (await opts.statPath(p)) !== null
      return pathExists((at) => ops.stat(accessor, at), local(p))
    },
  )
}

export const BUILDER: GenericCommand = {
  name: 'mktemp',
  write: true,
  fn: mktemp,
}
