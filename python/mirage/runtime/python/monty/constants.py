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
from mirage.runtime.python.monty.errors import cpython_error

MISSING_EXTRA_HINT = (
    "the monty runtime requires the 'monty' extra. Install with: "
    "pip install mirage-ai[monty], or select the 'local' runtime")

# What argv[0] is when the caller has no program name of its own.
DEFAULT_PROG = "main.py"

# Monty reports an unfinished suite as a syntax error like any other, so
# a console can only tell "keep typing" from "this is broken" by the
# traceback text. Coupled to monty's wording on purpose, and the reason
# it is named here rather than inline: a version bump that rephrases
# either line turns every continuation into an error at the prompt.
INCOMPLETE_MARKERS = ("unexpected EOF", "Expected an indented block")

# POSIX's answer for a rename across filesystems. Monty ships no shutil,
# so guest code writes the copy-and-delete fallback by hand; the errno
# is what tells it to. The phrase is the CPython table's, so the py and
# ts encoders cannot drift apart on it.
EXDEV_MESSAGE = cpython_error(FsCondition.CROSS_MOUNT).phrase

FILE_EXISTS_MESSAGE = "[Errno 17] File exists: {path!r}"
