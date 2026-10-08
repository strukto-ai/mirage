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

EXPORT_USAGE = "export: usage: export [-fn] [name[=value] ...] or export -p\n"

READONLY_USAGE = (
    "readonly: usage: readonly [-aAf] [name[=value] ...] or readonly -p\n"
)

# bash takes `-a` / `-A` too, though its usage line names only `-fn`.
EXPORT_FLAGS = frozenset("aAfnp")

READONLY_FLAGS = frozenset("aAfp")

# The declaration builtins that assign whichever variable is visible, a
# function's local or else the global; `declare` and `local` make a new
# local inside a function instead.
VISIBLE_SCOPE_BUILTINS = frozenset({"export", "readonly"})

ANSI_C_ESCAPES = {
    "\\": "\\\\",
    "'": "\\'",
    "\a": "\\a",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\v": "\\v",
    "\f": "\\f",
    "\r": "\\r",
    "\x1b": "\\E",
}

BARE_KEY_RE = re.compile(r"[A-Za-z0-9_%+,./:=@~-]+\Z")

# `arr[0]` and friends: a target that parses as an assignment but is
# not a plain name, which the declaration builtins quote on its own.
SUBSCRIPT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\[.*\]")
