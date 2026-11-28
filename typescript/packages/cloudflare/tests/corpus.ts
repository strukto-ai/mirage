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

// The test Worker with every CLI installed: the API tests and the integ
// corpus run each CLI's cases against it.
import '../src/clis/airtable.ts'
import '../src/clis/ast_grep.ts'
import '../src/clis/discord.ts'
import '../src/clis/gh.ts'
import '../src/clis/git.ts'
import '../src/clis/gws.ts'
import '../src/clis/hf.ts'
import '../src/clis/himalaya.ts'
import '../src/clis/linear.ts'
import '../src/clis/ntn.ts'
import '../src/clis/office.ts'
import '../src/clis/pdf.ts'
import '../src/clis/search.ts'
import '../src/clis/slack.ts'
import '../src/clis/trello.ts'
import '../src/clis/tvly.ts'

export * from './worker.ts'
export { default } from './worker.ts'
