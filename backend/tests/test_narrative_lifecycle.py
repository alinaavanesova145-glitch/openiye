import asyncio

from app.api.main import _cancel_pending_narratives, _pending_narrative_tasks


def test_pending_narrative_tasks_cancel_cleanly_on_shutdown():
    """A narrative task that hasn't finished by shutdown must be cancelled and
    awaited cleanly — never leaked as a 'Task was destroyed but it is pending'
    warning."""

    async def _scenario():
        async def _never_finishes():
            await asyncio.sleep(100)

        task = asyncio.create_task(_never_finishes())
        _pending_narrative_tasks.add(task)
        task.add_done_callback(_pending_narrative_tasks.discard)

        await _cancel_pending_narratives()

        assert task.cancelled()
        assert task not in _pending_narrative_tasks

    asyncio.run(_scenario())


def test_narrative_semaphore_caps_concurrency():
    from app.api.main import NARRATIVE_CONCURRENCY_LIMIT, _narrate_semaphore

    assert NARRATIVE_CONCURRENCY_LIMIT == 4
    assert _narrate_semaphore._value == NARRATIVE_CONCURRENCY_LIMIT
