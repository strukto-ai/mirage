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

import { registerBackendCommands } from '@struktoai/mirage-core/commands/builtin/backends'
import { DiskVFS } from '../../vfs/disk/disk.ts'
import { EmailVFS } from '../../vfs/email/email.ts'
import { GridFSVFS } from '../../vfs/gridfs/gridfs.ts'
import { HfBucketsVFS } from '../../vfs/hf_buckets/hf_buckets.ts'
import { HfHubVFS } from '../../vfs/hf_hub/base.ts'
import { NextcloudVFS } from '../../vfs/nextcloud/nextcloud.ts'
import { SSHVFS } from '../../vfs/ssh/ssh.ts'
import { DISK_COMMANDS } from './disk/index.ts'
import { EMAIL_COMMANDS } from './email/index.ts'
import { GRIDFS_COMMANDS } from './gridfs/index.ts'
import { HF_BUCKETS_COMMANDS } from './hf_buckets/index.ts'
import { HF_HUB_COMMANDS } from './hf_hub/index.ts'
import { NEXTCLOUD_COMMANDS } from './nextcloud/index.ts'
import { SSH_COMMANDS } from './ssh/index.ts'

// The shell commands of the backends this package ships.
registerBackendCommands(DiskVFS, () => DISK_COMMANDS)
registerBackendCommands(EmailVFS, () => EMAIL_COMMANDS)
registerBackendCommands(GridFSVFS, () => GRIDFS_COMMANDS)
registerBackendCommands(HfBucketsVFS, () => HF_BUCKETS_COMMANDS)
registerBackendCommands(HfHubVFS, () => HF_HUB_COMMANDS)
registerBackendCommands(NextcloudVFS, () => NEXTCLOUD_COMMANDS)
registerBackendCommands(SSHVFS, () => SSH_COMMANDS)
