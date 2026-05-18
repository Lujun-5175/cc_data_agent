from __future__ import annotations

from pathlib import Path
import time


def test_pty_session_exposes_runtime_methods():
    from web.server import _PtySession

    assert callable(getattr(_PtySession, "write", None))
    assert callable(getattr(_PtySession, "resize", None))
    assert callable(getattr(_PtySession, "close", None))


def test_reap_stale_chat_sessions_evicts_cache_only(tmp_path, monkeypatch):
    from web import api as _apimod
    from web import db as _dbmod

    db_path = tmp_path / "web-test.db"
    monkeypatch.setenv("CHEETAHCLAWS_WEB_DB", str(db_path))
    _dbmod._engine = None
    _dbmod._SessionLocal = None
    _dbmod.init_db(Path(db_path))

    user = _dbmod.repo.create_user("alice", "hash", is_admin=True)
    _dbmod.repo.upsert_session("sess-1", user["id"], title="Keep me", config={})

    cleaned = []

    class _FakeSession:
        user_id = user["id"]

        def is_stale(self):
            return True

        def is_idle(self):
            return True

        def cleanup(self):
            cleaned.append(True)

    _apimod._chat_sessions.clear()
    _apimod._chat_sessions["sess-1"] = _FakeSession()

    _apimod.reap_stale_chat_sessions()

    assert "sess-1" not in _apimod._chat_sessions
    assert cleaned == [True]
    assert _dbmod.repo.get_session("sess-1", user["id"]) is not None


def test_chat_session_uses_monotonic_last_active(tmp_path, monkeypatch):
    from web.api import ChatSession
    from web import db as _dbmod

    db_path = tmp_path / "web-test.db"
    monkeypatch.setenv("CHEETAHCLAWS_WEB_DB", str(db_path))
    _dbmod._engine = None
    _dbmod._SessionLocal = None
    _dbmod.init_db(Path(db_path))

    user = _dbmod.repo.create_user("alice", "hash", is_admin=True)
    sess = ChatSession({"model": "test-model"}, user["id"])

    assert 0 <= (time.monotonic() - sess.last_active) < 5


def test_submit_prompt_sets_busy_before_thread_start(tmp_path, monkeypatch):
    from web.api import ChatSession
    from web import db as _dbmod

    db_path = tmp_path / "web-test.db"
    monkeypatch.setenv("CHEETAHCLAWS_WEB_DB", str(db_path))
    _dbmod._engine = None
    _dbmod._SessionLocal = None
    _dbmod.init_db(Path(db_path))

    user = _dbmod.repo.create_user("alice", "hash", is_admin=True)
    sess = ChatSession({"model": "test-model"}, user["id"])
    observed = {}

    class _NoStartThread:
        def __init__(self, target=None, daemon=None):
            observed["busy_before_start"] = sess._busy.is_set()
            self._target = target
        def start(self):
            observed["start_called"] = True

    monkeypatch.setattr("web.api.threading.Thread", _NoStartThread)

    accepted = sess.submit_prompt("hello")

    assert accepted is True
    assert observed["busy_before_start"] is True
    assert observed["start_called"] is True
    assert sess._busy.is_set() is True
    sess._end_turn()


def test_handle_slash_sync_rejects_reentry_when_busy(tmp_path, monkeypatch):
    from web.api import ChatSession
    from web import db as _dbmod

    db_path = tmp_path / "web-test.db"
    monkeypatch.setenv("CHEETAHCLAWS_WEB_DB", str(db_path))
    _dbmod._engine = None
    _dbmod._SessionLocal = None
    _dbmod.init_db(Path(db_path))

    user = _dbmod.repo.create_user("alice", "hash", is_admin=True)
    sess = ChatSession({"model": "test-model"}, user["id"])
    sess._busy.set()

    events = sess.handle_slash_sync("/status")

    assert events == [{"type": "error", "data": {"message": "Agent is busy"}}]
