# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import re

IDENTIFIER_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
# A number as bash's builtins read one: strtoimax's leading whitespace
# and sign, then the trailing blanks bash skips itself.
COUNT_WORD_RE = re.compile(r"[ \t\n\v\f\r]*[+-]?[0-9]+[ \t]*")

# An assignment target with an optional subscript (`name` or `name[sub]`).
# A subscript must be non-empty: bash rejects `a[]` as an invalid
# identifier, while `a[ ]` is a valid arithmetic 0.
TARGET_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)(?:\[(.+)\])?\Z")

# What makes bash's bare `set` single-quote a value: IFS whitespace,
# quoting and control characters, reserved-word and glob characters, and
# the expansion introducers (`$` and a backquote). A `~` counts at
# the start or after `=` or `:`, and a `#` only at the start.
SET_QUOTED_CHARS = frozenset(" \t\n'\"\\|&;()<>!{}*[?]^$`")
