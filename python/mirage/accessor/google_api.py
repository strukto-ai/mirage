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

from mirage.accessor.base import Accessor
from mirage.core.gcal.api import CalendarApi, CalendarClient
from mirage.core.gdocs.api import DocsApi, DocsClient
from mirage.core.gdrive.api import DriveApi, DriveClient
from mirage.core.gmail.api import GmailApi, GmailClient
from mirage.core.google.client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.core.gsheets.api import SheetsApi, SheetsClient
from mirage.core.gslides.api import SlidesApi, SlidesClient


class GoogleApiAccessor(Accessor):
    def __init__(
        self, config: GoogleConfig, token_manager: TokenManager
    ) -> None:
        self.config = config
        self.token_manager = token_manager

    @property
    def drive(self) -> DriveApi:
        """The one door every Drive request goes through."""
        return DriveClient(self.token_manager)

    @property
    def docs(self) -> DocsApi:
        """The one door every Docs request goes through."""
        return DocsClient(self.token_manager)

    @property
    def sheets(self) -> SheetsApi:
        """The one door every Sheets request goes through."""
        return SheetsClient(self.token_manager)

    @property
    def slides(self) -> SlidesApi:
        """The one door every Slides request goes through."""
        return SlidesClient(self.token_manager)

    @property
    def gmail(self) -> GmailApi:
        """The one door every Gmail request goes through."""
        return GmailClient(self.token_manager)

    @property
    def calendar(self) -> CalendarApi:
        """The one door every Calendar request goes through."""
        return CalendarClient(self.token_manager)

    async def close(self) -> None:
        """Drain the token manager's connection pool. Idempotent."""
        await self.token_manager.close()
