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

from email.message import Message
from email.parser import BytesParser
from email.policy import default as default_policy

import aiosmtplib

from mirage.core.email.config import EmailConfig
from mirage.resource.secrets import reveal_secret


async def send_raw(config: EmailConfig, raw: bytes) -> Message:
    """Push an RFC 5322 message through the account's SMTP path.

    Sending lives with the CLI rather than in ``core/email`` because
    the email mount is read-only: no filesystem operation reaches
    SMTP, and himalaya is the only thing that sends.

    Args:
        config (EmailConfig): SMTP credentials and host.
        raw (bytes): the complete RFC 5322 message.

    Returns:
        Message: the parsed message, so callers can report its headers.
    """
    message = BytesParser(policy=default_policy).parsebytes(raw)
    # start_tls=None upgrades opportunistically when the server advertises
    # STARTTLS and stays plaintext otherwise, mirroring nodemailer's
    # behavior in the TS backend (which only forces TLS on port 465).
    await aiosmtplib.send(
        message,
        hostname=config.smtp_host,
        port=config.smtp_port,
        username=config.username,
        password=reveal_secret(config.password),
        start_tls=None,
    )
    return message
