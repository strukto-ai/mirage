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

ALIAS_USAGE = "alias: usage: alias [-p] [name[=value] ... ]"
UNALIAS_USAGE = "unalias: usage: unalias [-a] name [name ...]"

# The names bash's `alias` refuses: a shell metacharacter, a quote, `/`,
# `$` or a backtick anywhere in the name makes it unusable, since the parser
# would never read such a word as one command name.
BAD_NAME_CHARS = frozenset(" \t\n/=$`'\"|&;()<>")

FIRST_WORD = re.compile(r"\S+")
