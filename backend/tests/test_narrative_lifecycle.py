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


# ─── Queue depth cap (2026-08-27 sprint) ────────────────────────────────────
#
# NARRATIVE_CONCURRENCY_LIMIT only ever bounded how many narrative calls run
# *concurrently* -- nothing bounded how many could queue up behind it, so a
# burst of anomaly-triggering uploads could pile tasks in
# _pending_narrative_tasks unboundedly (each Ollama call takes ~15-22s).


def test_spawn_narrative_task_drops_once_pending_cap_reached():
    from app.api.main import (
        MAX_PENDING_NARRATIVE_TASKS,
        _pending_narrative_tasks,
        _spawn_narrative_task,
    )

    async def _scenario():
        async def _never_finishes():
            await asyncio.sleep(100)

        # Fill the queue to exactly the cap with tasks that never complete
        # on their own -- distinguishable from real _narrate() tasks so we
        # can assert none of them ran generate_anomaly_explanation.
        filler_tasks = []
        for _ in range(MAX_PENDING_NARRATIVE_TASKS):
            t = asyncio.create_task(_never_finishes())
            _pending_narrative_tasks.add(t)
            t.add_done_callback(_pending_narrative_tasks.discard)
            filler_tasks.append(t)

        assert len(_pending_narrative_tasks) == MAX_PENDING_NARRATIVE_TASKS

        # One more spawn attempt, over the cap, must be a silent no-op --
        # not an exception, not a growth in the pending set.
        _spawn_narrative_task("frame-over-cap", "irrelevant summary text")
        assert len(_pending_narrative_tasks) == MAX_PENDING_NARRATIVE_TASKS

        for t in filler_tasks:
            t.cancel()
        await asyncio.gather(*filler_tasks, return_exceptions=True)

    asyncio.run(_scenario())
