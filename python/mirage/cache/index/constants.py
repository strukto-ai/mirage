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

# One payload layout, shared by both languages and never versioned: a row
# is the JSON IndexEntry / IndexDirectory writes, and a row that does not
# parse is an error, not a miss. Earlier layouts are not read; flush the key
# prefix when upgrading workers that share an index.
ENTRY_PREFIX = "mirage:idx:entry:"
CHILDREN_PREFIX = "mirage:idx:directory:"
TOMBSTONE_PREFIX = "mirage:idx:tombstone:"

PATHS_KEY = "mirage:idx:paths"

GENERATION_KEY = "mirage:idx:generation"

# How long, in seconds, a read that belongs to no shell command trusts a
# listing under `read: fresh`. One FUSE `ls -l` is a burst of such reads.
LISTING_TRUST_WINDOW = 1.0

# How many remembered probe answers a mount keeps before it drops those of
# commands other than the running one. Only the probing command is ever
# served an answer, so a dropped entry costs at most one backend stat.
PROBED_LIMIT = 4096

# How many remembered listing version checks a mount keeps before it drops
# those no caller can trust any more. A dropped entry costs at most one more
# check, never a stale listing.
CHECKED_LIMIT = 4096

# Path-registry members one Redis script reads before handing back a cursor,
# in the scripts that page their walk under a path: the subtree probe and the
# prefix delete. Members are every row, listing, tombstone and generation
# path still registered, so a folder with a long history is walked in bounded
# steps rather than in one atomic call that blocks the shared server.
REGISTRY_PAGE = 128
