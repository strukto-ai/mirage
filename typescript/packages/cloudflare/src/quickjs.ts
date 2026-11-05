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

import { provideQuickJsModule } from '@struktoai/mirage-core/runtime/js/quickjs/loader'
import qjs from './generated/qjs-wasi.wasm'

// The node and js commands' engine, compiled as the Worker deploys, since an
// isolate compiles no wasm as it runs: each run's guest runs in the isolate
// itself, its wasm stack suspended on every call it makes of the host (JSPI).
provideQuickJsModule(() => Promise.resolve(qjs))
