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

import { GoogleApiAccessor } from './google_api.ts'
import type { DriveApi } from '../core/gdrive/api.ts'
import { driveApi } from '../core/gdrive/api.ts'

export class GDriveAccessor extends GoogleApiAccessor {
  // Built per access rather than memoized in the constructor: a resource
  // constructs its accessor long before a test installs a fake, so a cached
  // client would pin the live wire calls for the whole run.
  get drive(): DriveApi {
    return driveApi(this.tokenManager)
  }
}
