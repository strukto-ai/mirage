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

import { PathSpec } from '../types.ts'

// The root working directory, as Context.cwd defaults to it: the promoted
// shape runCommand gives "/" on an unprefixed mount. A frozen PathSpec, so
// one instance serves every default.
export const ROOT_CWD = new PathSpec({
  virtual: '/',
  directory: '/',
  vfsPath: '',
  resolved: false,
})
