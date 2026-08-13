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

export { BUILTIN_SPECS as SPECS, specOf } from './builtins.ts'

export { AMBIGUOUS_NAMES, flagKwargName } from './constants.ts'
export { parseCommand, parseToKwargs } from './parser.ts'
export {
  CommandSpec,
  type CommandSpecInit,
  type FlagValue,
  FlagView,
  Operand,
  type OperandInit,
  type ValueType,
  Option,
  type OptionInit,
  ParsedArgs,
  type ParsedArgsInit,
  specFlagNames,
  UsageStyle,
} from './types.ts'
