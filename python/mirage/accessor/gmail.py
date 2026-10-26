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

from collections.abc import Callable

from mirage.accessor.google_api import GoogleApiAccessor
from mirage.core.google.client import TokenManager
from mirage.vfs.gmail.config import GmailConfig


class GmailAccessor(GoogleApiAccessor):
    config: GmailConfig

    def __init__(
        self,
        config: GmailConfig,
        token_manager: TokenManager,
        capped: Callable[[], bool] = lambda: True,
    ) -> None:
        """Args:
        config (GmailConfig): the account.
        token_manager (TokenManager): its tokens.
        capped (Callable[[], bool]): whether the mount walks under a
            ``walk_limit``, asked when a listing runs, since the mount
            settles its own once mounted; a listing then keeps each
            message's text for the search.
        """
        super().__init__(config, token_manager)
        self.capped = capped
