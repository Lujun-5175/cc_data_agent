import threading

from cc_config import load_config
from cheetahclaws import _start_headless_bridges


def main() -> None:
    cfg = load_config()
    cfg.setdefault("_session_id", "wechat-headless")
    _start_headless_bridges(cfg)
    print("HEADLESS_BRIDGES_STARTED", flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
