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


class SecretsError(Exception):
    """A secrets source could not answer, or was addressed wrongly.

    One type for the whole package: fetch failures, malformed refs and
    registry misses all speak it with distinct messages. These are
    host-plane errors in mirage's config voice; the agent plane only
    ever sees one as a failed command's stderr naming the variable and
    the source it needed.
    """
