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

from typing import Final

from mirage.errors import FsCondition

# Capture unresolved program names without taking over the workspace shell.
EXTERNAL_COMMANDS: Final = "@external"

# The most requests one runtime file door keeps in flight: classifying
# an entry is a request of its own on a mount that keeps no listing
# index, so an unbounded listing puts a whole directory's worth on the
# wire.
LISTING_ENTRY_CONCURRENCY: Final = 16

# What a stat or a listing may answer "not there" with. A directory is
# an answer to both rather than an absence, and a backend that refused
# the op has not said the path is gone: folding a permission or a
# transport failure into "no" reports it as an absence the guest cannot
# tell from a real one, so nothing else belongs here.
ABSENT_PATH: Final = (FileNotFoundError, NotADirectoryError)

# What a hard link is refused with, wherever one can be spelled
# (preview1's `path_link`, the process patch's `os.link`): a hard link
# is a second name for one inode, and nothing above a mount holds that.
HARD_LINK_REFUSAL: Final = FsCondition.EPERM

# How long one policy script (a profile's ``policy:``, a ``route_policy``
# or a runtime's ``script:``) may run before the line it judges is
# refused or the route it decides fails. One bound for every stage.
SCRIPT_EVAL_TIMEOUT_SECONDS = 10.0
