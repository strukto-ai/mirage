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

# Conservative cap on distinct pending paths in a coalescing queue before
# the overflow policy fires. Not tied to any provider limit.
DEFAULT_MAX_PENDING = 4096

# Seconds between delta pulls when a source has no push doorbell. The
# feature request (#450) is webhook-first and does not specify a cadence;
# this is a portable default that a caller can override per watcher.
DEFAULT_POLL_INTERVAL = 30.0

# Snapshot detector value marking a directory entry in the listing diff.
DIR_DETECTOR = "dir"
