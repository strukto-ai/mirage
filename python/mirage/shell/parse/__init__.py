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

from mirage.shell.parse.env import env_reads, implicit_reads, opaque_reads
from mirage.shell.parse.names import (arith_reads, assignment_values,
                                      command_invocations, command_words,
                                      identifier_names, referenced_names)
from mirage.shell.parse.parse import (BASH_LANGUAGE, TS_PARSER, parse,
                                      strip_line_continuation)
from mirage.shell.parse.syntax import (find_syntax_error,
                                       find_unterminated_backtick,
                                       syntax_error_result)

__all__ = [
    "BASH_LANGUAGE",
    "TS_PARSER",
    "arith_reads",
    "assignment_values",
    "command_invocations",
    "command_words",
    "env_reads",
    "find_syntax_error",
    "find_unterminated_backtick",
    "identifier_names",
    "implicit_reads",
    "opaque_reads",
    "parse",
    "referenced_names",
    "strip_line_continuation",
    "syntax_error_result",
]
