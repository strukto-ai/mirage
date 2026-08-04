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

from mirage.shell.types import ShellBuiltin

# Reserved command-name pools. A leaf on purpose: both route (dispatch
# precedence) and the CLI registry (install-time collision rule) read
# these, and route already imports the mount layer, so the pools cannot
# live under route without a cycle.

# Bash builtins the parser accepts but the executor cannot honor; they
# still route to the shell layer so the error names a capability gap.
UNSUPPORTED_BUILTINS = frozenset({
    "bg",
    "disown",
    "exec",
    "complete",
    "compgen",
    "ulimit",
})

NAMESPACE_COMMANDS = frozenset({"ln", "readlink"})

# bash reserved words that mirage's grammar implements. The parser, not
# the executor, consumes them, so they never reach route; `type` reports
# them and the CLI registry refuses them as head words. bash's `time`
# and `coproc` are left out on purpose: mirage implements neither
# construct, so a line starting with one reports `command not found`,
# and `type` may not contradict what dispatch does. Add a word back
# when its construct lands.
KEYWORDS = frozenset({
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "case",
    "esac",
    "for",
    "select",
    "while",
    "until",
    "do",
    "done",
    "in",
    "function",
    "{",
    "}",
    "!",
    "[[",
    "]]",
})

# ShellBuiltin subset handled through the job table in the executor.
JOB_BUILTINS = frozenset({"wait", "fg", "kill", "jobs", "ps"})

# Commands with lstat semantics: they act on the symlink entry itself,
# so dispatch must not rewrite their operands through the link table.
# `stat` is here because GNU stat lstats, but it takes -L to dereference
# after all, which route's `dereferences` reads back out of the command
# line; `file`, `du` and `find` are the same shape.
NO_FOLLOW_COMMANDS = frozenset({
    "rm", "mv", "ln", "readlink", "rmdir", "unlink", "stat", "file", "du",
    "find"
})

SHELL_NAMES = frozenset(str(b) for b in ShellBuiltin) | UNSUPPORTED_BUILTINS
