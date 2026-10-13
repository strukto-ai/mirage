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

from mirage.errors import FsCondition

MISSING_EXTRA_HINT = (
    "the monty runtime requires the 'monty' extra. Install with: "
    "pip install mirage-ai[monty], or select the 'local' runtime"
)

# What argv[0] is when the caller has no program name of its own.
DEFAULT_PROG = "main.py"
MAX_URANDOM_BYTES = 1_048_576

# Monty ends a session past this many host round trips, and every file
# call is one or two, so its default of 1000 stopped a loop of 500 reads.
# The count cannot be turned off, so a checkout sets it past what any run
# reaches; the command limits bound a run instead.
LIMITS = {"max_suspensions": 2**31 - 1}

# Monty reports an unfinished suite as a syntax error like any other, so
# a console can only tell "keep typing" from "this is broken" by the
# traceback text. Coupled to monty's wording on purpose, and the reason
# it is named here rather than inline: a version bump that rephrases
# either line turns every continuation into an error at the prompt.
INCOMPLETE_MARKERS = ("unexpected EOF", "Expected an indented block")

# What a refused readlink may mean "no link here". EINVAL is the backend
# saying the path is not one, and the other three are CPython's own
# `_ignore_error` list, which is what `Path.is_symlink` swallows around
# its lstat. Everything else propagates: CPython re-raises
# PermissionError out of `is_symlink`, and reporting a refusal as "not a
# link" is an answer the guest cannot tell from one.
NOT_A_LINK = frozenset(
    {
        FsCondition.EINVAL,
        FsCondition.ENOENT,
        FsCondition.ENOTDIR,
        FsCondition.ELOOP,
    }
)
