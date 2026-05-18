from __future__ import annotations

import threading


# Bridge slash commands temporarily replace process-global sys.stdout/stderr
# so print()-based command output can be forwarded back to chat. Serialize
# that capture to avoid cross-session output bleed between concurrent bridges.
STDIO_CAPTURE_LOCK = threading.RLock()
