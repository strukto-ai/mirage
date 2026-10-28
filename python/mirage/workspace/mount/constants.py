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

# What a backend function may declare to be handed, each filled from the
# mount's stored listings: the stat of what is at its path and at its
# path's parent, and the same two at a rename's or a copy's destination.
HANDED = frozenset({"entry", "parent", "dst_entry", "dst_parent"})

# The ops a VFS's stored listings answer without asking it: a listing, a
# stat its parent's listing holds, and a subtree read every listing under
# it holds.
STORED_OPS = frozenset({"readdir", "stat", "read_tree"})
