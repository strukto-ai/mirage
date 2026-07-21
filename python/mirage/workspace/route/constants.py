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

# ShellBuiltin subset handled through the job table in the executor.
JOB_BUILTINS = frozenset({"wait", "fg", "kill", "jobs", "ps"})

# Commands with lstat semantics: they act on the symlink entry itself,
# so dispatch must not rewrite their operands through the link table.
NO_FOLLOW_COMMANDS = frozenset(
    {"rm", "mv", "ln", "readlink", "rmdir", "unlink"})

SHELL_NAMES = frozenset(str(b) for b in ShellBuiltin) | UNSUPPORTED_BUILTINS
