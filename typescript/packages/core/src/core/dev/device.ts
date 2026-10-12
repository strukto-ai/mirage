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

import { PipeFiles } from './mixin.ts'
import type { DevicePipe } from './pipe.ts'
import type { RAMAccessor } from '../../accessor/ram.ts'

interface DeviceFiles {
  deviceOf(key: string): string | null
}

export function activeDevice(accessor: RAMAccessor, key: string): string | null {
  const files = accessor.store.files as Map<string, Uint8Array> & Partial<DeviceFiles>
  return typeof files.deviceOf === 'function' ? files.deviceOf(key) : null
}

export function activePipe(accessor: RAMAccessor, key: string): DevicePipe | null {
  const files = accessor.store.files
  return files instanceof PipeFiles ? files.pipeOf(key) : null
}
