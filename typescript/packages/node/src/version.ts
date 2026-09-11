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

// The attribute is load-bearing: this package ships as a module tree
// (tsc, one file per module), so the import reaches Node as written and
// Node refuses a JSON module without it (ERR_IMPORT_ATTRIBUTE_MISSING),
// which took the daemon down at startup. The old bundler inlined the
// file and hid that. Same spelling as core's version.ts.
import pkg from '../package.json' with { type: 'json' }

export const VERSION: string = pkg.version
