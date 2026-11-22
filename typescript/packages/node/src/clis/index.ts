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

// Node bundles nothing, so every entry that builds a workspace installs
// each CLI that carries an engine; a browser page or a Worker imports only
// the `clis/` entries it wants.
export { AST_GREP } from '@struktoai/mirage-core/clis/ast_grep'
export { GH } from '@struktoai/mirage-core/clis/gh'
export { OFFICE } from '@struktoai/mirage-core/clis/office'
export { PDFINFO, PDFTOTEXT } from '@struktoai/mirage-core/clis/pdf'
