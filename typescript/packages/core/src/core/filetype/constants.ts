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

export const MAX_PREVIEW_ROWS = 20

export const CANONICAL_TYPES: Record<string, string> = {
  int8: 'int8',
  int16: 'int16',
  int32: 'int32',
  int64: 'int64',
  uint8: 'uint8',
  uint16: 'uint16',
  uint32: 'uint32',
  uint64: 'uint64',
  int96: 'int96',
  halffloat: 'float16',
  float16: 'float16',
  float: 'float32',
  float32: 'float32',
  double: 'float64',
  float64: 'float64',
  string: 'string',
  large_string: 'string',
  utf8: 'string',
  largeutf8: 'string',
  str: 'string',
  object: 'string',
  byte_array: 'string',
  fixed_len_byte_array: 'string',
  bool: 'bool',
  boolean: 'bool',
}
