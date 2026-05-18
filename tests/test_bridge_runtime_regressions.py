from __future__ import annotations

import threading


def test_dispatch_tg_job_sets_busy_before_thread_start(monkeypatch):
    from bridges import telegram as tg

    observed = {}
    tg._tg_busy.clear()

    class _NoStartThread:
        def __init__(self, target=None, args=(), kwargs=None, daemon=False, **_):
            observed["busy_before_start"] = tg._tg_busy.is_set()
            self._target = target
        def start(self):
            observed["start_called"] = True

    monkeypatch.setattr(tg.threading, "Thread", _NoStartThread)

    tg._dispatch_tg_job(
        object(), "hello", "tok", 1,
        lambda *_a, **_k: None, object(), {}
    )

    assert observed["busy_before_start"] is True
    assert observed["start_called"] is True
    assert tg._tg_busy.is_set() is True
    tg._tg_busy.clear()


def test_dispatch_sl_job_sets_busy_before_thread_start(monkeypatch):
    from bridges import slack as sl

    observed = {}
    sl._sl_busy.clear()

    class _NoStartThread:
        def __init__(self, target=None, args=(), kwargs=None, daemon=False, **_):
            observed["busy_before_start"] = sl._sl_busy.is_set()
            self._target = target
        def start(self):
            observed["start_called"] = True

    monkeypatch.setattr(sl.threading, "Thread", _NoStartThread)

    sl._dispatch_sl_job(
        object(), "hello", "tok", "chan",
        lambda *_a, **_k: None, object(), {}
    )

    assert observed["busy_before_start"] is True
    assert observed["start_called"] is True
    assert sl._sl_busy.is_set() is True
    sl._sl_busy.clear()


def test_bridge_stdio_capture_lock_is_shared():
    from bridges import telegram as tg
    from bridges import slack as sl
    from bridges import wechat as wx
    from bridges._stdio_capture import STDIO_CAPTURE_LOCK

    assert tg.STDIO_CAPTURE_LOCK is STDIO_CAPTURE_LOCK
    assert sl.STDIO_CAPTURE_LOCK is STDIO_CAPTURE_LOCK
    assert wx.STDIO_CAPTURE_LOCK is STDIO_CAPTURE_LOCK
    assert isinstance(STDIO_CAPTURE_LOCK, type(threading.RLock()))
