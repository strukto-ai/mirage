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

import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { Workspace as CoreWorkspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { savedVfsBuild } from '@struktoai/mirage-core/workspace/snapshot/state'
import type { MountSnapshot } from '@struktoai/mirage-core/workspace/snapshot/types'
import { buildVfs, knownVfsNames } from './vfs/registry.ts'
import { watch } from '@struktoai/mirage-core/io/web/gateway'
import { MachineId } from '@struktoai/mirage-core/execution/types'
import { refuseUnseenAddresses, watchNetwork } from '@struktoai/mirage-core/io/web/network'
import './io/spool.ts'

// TODO(MIRAGE-36): an OPFS spool store, so spools spill here too.
export class Workspace extends CoreWorkspace {
  /** A saved mount rebuilds through this package's VFS registry. */
  protected static override async buildSavedVfs(entry: MountSnapshot): Promise<BaseVFS | null> {
    const build = savedVfsBuild(entry, (name) => knownVfsNames().includes(name))
    return build === null ? null : buildVfs(build.name, build.config)
  }

  /** The page this workspace runs in, by its host; `page` outside one. */
  protected override hostMachine(): MachineId {
    const host = typeof location === 'undefined' ? '' : location.host
    return new MachineId('browser', host === '' ? 'page' : host)
  }

  constructor(...args: ConstructorParameters<typeof CoreWorkspace>) {
    refuseUnseenAddresses(args[1]?.network)
    super(...args)
    this.registry.setNetworkWatch(watchNetwork)
    if (this.registry.network !== null) watchNetwork()
    watch()
  }
}
