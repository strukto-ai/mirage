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

from typing import get_args

from mirage.policy.types import ScriptMethod

# The reason a deny leaf written without one carries, and the one an ask
# leaf written without one carries.
DEFAULT_DENY_REASON = "denied by policy"
DEFAULT_ASK_REASON = "no standing approval"

# Ops that read an entry's metadata and nothing of its content, which a
# deny rule lets through at the dispatcher: deny means present and
# refused, not absent, so a listing shows the entry's name and size
# and the read of it is what fails, as GNU reports an unreadable file.
# The command tier's guard leaves its ``stat`` slot unwrapped for the
# same reason; a hidden path is the hide arm's, and stays ENOENT.
# ``exists`` is the command tier's probe; ``stat`` is pinned to what the
# functions declare by tests/policy/test_constants.py: policy sits below
# vfs, so it cannot read the declarations itself.
METADATA_OPS = frozenset({"stat", "exists"})

# The methods a profile's policy names programs for: the pre_ five,
# answered before the action runs, and the post_ five, after it.
METHODS = get_args(ScriptMethod)

# The runtimes a policy program runs on: monty, and Python on wasm.
PROGRAM_RUNTIMES = frozenset({"monty", "wasi"})

# The runtime a policy program runs on when it names none.
PROGRAM_RUNTIME = "monty"

# The interpreter switches a program runs with, per runtime: ``-P``
# keeps the session's directory off ``sys.path``, so no file there
# stands in for a module the program imports. Monty has no
# ``sys.path``.
PROGRAM_FLAGS: dict[str, dict[str, bool]] = {"wasi": {"P": True}}

# The memory a policy program gets when its runtime's config names none:
# monty's own example cap, and enough for CPython on wasm, which starts
# at about 40M. ``max_memory: null`` in the config lifts it.
PROGRAM_MEMORY: dict[str, str] = {"monty": "10M", "wasi": "128M"}

# The environment variable a policy program reads its context from, as
# JSON; the same text arrives on stdin.
CTX_ENV = "MIRAGE_POLICY_CTX"
