import asyncio
import time

from app.api.main import BROADCAST_SEND_TIMEOUT, StreamHub


class _HangingWebSocket:
    """Simulates a slow/dead client whose send never completes."""

    async def send_text(self, message: str) -> None:
        await asyncio.sleep(BROADCAST_SEND_TIMEOUT + 5)


class _FastWebSocket:
    def __init__(self) -> None:
        self.received: list[str] = []

    async def send_text(self, message: str) -> None:
        self.received.append(message)


def test_broadcast_survives_slow_dead_client_without_stalling():
    """A hanging client must not delay delivery to healthy clients, and must
    be dropped as stale rather than left connected forever."""

    async def _scenario():
        hub = StreamHub()
        hanging = _HangingWebSocket()
        fast = _FastWebSocket()
        hub.active_connections.extend([hanging, fast])

        start = time.monotonic()
        await hub.broadcast_text("hello")
        elapsed = time.monotonic() - start

        assert elapsed < BROADCAST_SEND_TIMEOUT + 1.0
        assert fast.received == ["hello"]
        assert hanging not in hub.active_connections
        assert fast in hub.active_connections

    asyncio.run(_scenario())


def test_broadcast_to_no_clients_is_a_noop():
    async def _scenario():
        hub = StreamHub()
        await hub.broadcast_text("hello")  # must not raise with zero connections

    asyncio.run(_scenario())
