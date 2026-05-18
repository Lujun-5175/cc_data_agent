from __future__ import annotations

import base64
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


def test_submit_prompt_stages_uploaded_attachments_for_agent(tmp_path, monkeypatch):
    from web.api import ChatSession
    from web import api as _apimod
    from web import db as _dbmod
    import runtime

    db_path = tmp_path / "web-test.db"
    monkeypatch.setenv("CHEETAHCLAWS_WEB_DB", str(db_path))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(_apimod, "_ATTACHMENT_UPLOAD_ROOT", tmp_path / ".cheetahclaws" / "uploads")
    _dbmod._engine = None
    _dbmod._SessionLocal = None
    _dbmod.init_db(Path(db_path))

    user = _dbmod.repo.create_user("alice", "hash", is_admin=True)
    sess = ChatSession({"model": "test-model"}, user["id"])
    observed = {}

    class _NoStartThread:
        def __init__(self, target=None, daemon=None):
            observed["target"] = target
        def start(self):
            observed["start_called"] = True

    monkeypatch.setattr("web.api.threading.Thread", _NoStartThread)

    payload = "col1,col2\n1,2\n"
    accepted = sess.submit_prompt(
        "summarize this csv",
        attachments=[{
            "name": "report.csv",
            "type": "text/csv",
            "data": "data:text/csv;base64," + base64.b64encode(payload.encode()).decode(),
        }],
    )

    assert accepted is True
    assert observed["start_called"] is True
    pending = runtime.get_session_ctx(sess.session_id).pending_files
    assert len(pending) == 1
    saved = Path(pending[0]["path"])
    assert saved.exists()
    assert saved.read_text(encoding="utf-8") == payload
    assert pending[0]["kind"] == "spreadsheet"
    sess._end_turn()


def test_append_pending_file_hints_mentions_matching_tools():
    from agent import _append_pending_file_hints

    msg = {"role": "user", "content": "Please review these uploads."}
    _append_pending_file_hints(msg, [
        {"name": "report.pdf", "path": "/tmp/report.pdf", "kind": "pdf"},
        {"name": "sales.xlsx", "path": "/tmp/sales.xlsx", "kind": "spreadsheet"},
        {"name": "notes.txt", "path": "/tmp/notes.txt", "kind": "text"},
    ])

    content = msg["content"]
    assert "ReadPDF" in content
    assert "ReadSpreadsheet" in content
    assert "Use `Read` to inspect it." in content


def test_stage_attachment_upload_returns_token_and_consumes_once(tmp_path, monkeypatch):
    from web.api import ChatSession
    from web import api as _apimod
    from web import db as _dbmod

    db_path = tmp_path / "web-test.db"
    monkeypatch.setenv("CHEETAHCLAWS_WEB_DB", str(db_path))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(_apimod, "_ATTACHMENT_UPLOAD_ROOT", tmp_path / ".cheetahclaws" / "uploads")
    _dbmod._engine = None
    _dbmod._SessionLocal = None
    _dbmod.init_db(Path(db_path))

    user = _dbmod.repo.create_user("alice", "hash", is_admin=True)
    sess = ChatSession({"model": "test-model"}, user["id"])

    uploaded = sess.stage_attachment_upload("sheet.csv", "text/csv", b"a,b\n1,2\n")
    assert uploaded["token"]
    assert uploaded["kind"] == "spreadsheet"

    consumed = sess._consume_staged_uploads([uploaded["token"]])
    assert len(consumed) == 1
    assert Path(consumed[0]["path"]).exists()
    assert sess._consume_staged_uploads([uploaded["token"]]) == []
