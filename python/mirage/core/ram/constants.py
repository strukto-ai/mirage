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

# How often a streamed write shows what has arrived so far: a reader sees a
# slow writer's file grow. The store keeps each file whole, so each showing
# copies the file; past PUBLISH_BYTES the wait grows with the file, so a long
# write copies about PUBLISH_BYTES a wait rather than its size squared.
STREAM_PUBLISH_SECONDS = 0.1
PUBLISH_BYTES = 16 * 1024 * 1024
