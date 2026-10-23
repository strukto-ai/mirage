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

from pydantic import BaseModel, ConfigDict, SecretStr


class EmailConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    imap_host: str
    """IMAP server hostname."""
    imap_port: int = 993
    """IMAP server port."""
    smtp_host: str
    """SMTP server hostname `himalaya` sends mail through."""
    smtp_port: int = 587
    """SMTP server port. `465` uses implicit TLS; any other port starts in
    plaintext and upgrades with STARTTLS when the server offers it."""
    username: str
    """Login for both IMAP and SMTP, usually the email address."""
    password: SecretStr
    """Password or app password for `username`."""
    use_ssl: bool = True
    """Speak TLS from the first byte of the IMAP connection (IMAPS); off
    connects in plaintext. SMTP follows `smtp_port` instead."""
    max_messages: int = 200
    """How many of a folder's newest messages the mount lists and `grep`
    searches, and the window `himalaya envelope list` and `search` page
    through."""
    content_search: bool = False
    """Let `grep` and `rg` ask the server (IMAP `SEARCH TEXT`) which
    messages may match and read only those. The server searches headers
    and body, not the mounted JSON's keys, uids or flags."""
    save_copy: bool = True
    """After `himalaya` sends a message, append a copy to `sent_folder`,
    as upstream himalaya's `message.send.save-copy`. Off saves a copy
    only when `--save` names a mailbox."""
    sent_folder: str | None = None
    """Mailbox a sent copy goes to. Unset asks the server for the mailbox
    tagged `\\Sent` and falls back to `Sent`."""
