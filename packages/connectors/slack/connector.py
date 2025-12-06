from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx


@dataclass
class SlackConnector:
    bot_token: str
    base_url: str = "https://slack.com/api"

    async def post_message(self, channel: str, text: str) -> dict[str, Any]:
        async with httpx.AsyncClient(base_url=self.base_url, headers=self._headers) as client:
            response = await client.post(
                "/chat.postMessage",
                json={"channel": channel, "text": text},
                timeout=10.0,
            )
            response.raise_for_status()
            return response.json()

    @property
    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.bot_token}"}
