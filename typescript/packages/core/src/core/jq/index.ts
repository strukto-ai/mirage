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

export { JqCompileError, loadFailure } from './errors.ts'
export { Engine, localZone } from './eval.ts'
export type { Ending } from './eval.ts'
export { JqParser, decodeUtf8, readTexts, stringText, valueText } from './parse.ts'
export { DEFAULT_INDENT, JqParseError, NO_VALUE, STDIN_NAME, jqOptions } from './types.ts'
export type { JqError, JqHalt, JqOptions, JqRun, NoValue } from './types.ts'
