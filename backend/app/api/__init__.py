"""app/api — package marker.

Used to also build a second, complete, never-launched FastAPI app object
here (its own /api/health, /api/canvas, /api/inference routers, and its
own /ws/vectors WebSocket route) -- confirmed via grep across the whole
repo that nothing ever imports or serves it as an app (boot.sh and
backend/main.py both launch app.api.main:app, never app.api:app). The
one place that DID reference it, tests/test_api.py, was unknowingly
testing this dead app's responses instead of the real, live one's --
repointed at app.api.main:app (2026-08-27 sprint;
see docs/fullstack_audit_2026-08-27.md).
"""
