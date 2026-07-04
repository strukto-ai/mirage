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

import { ResourceName, makeSed } from '@struktoai/mirage-core'
import type { SSHAccessor } from '../../../accessor/ssh.ts'
import { stream as sshStream } from '../../../core/ssh/stream.ts'
import { stat as sshProvStat } from '../../../core/ssh/stat.ts'
import { writeBytes as sshWrite } from '../../../core/ssh/write.ts'

export const SSH_SED = makeSed<SSHAccessor>({
  stat: (a, p) => sshProvStat(a, p),
  resource: ResourceName.SSH,
  stream: (a, p) => sshStream(a, p),
  write: (a, p, d) => sshWrite(a, p, d),
})
