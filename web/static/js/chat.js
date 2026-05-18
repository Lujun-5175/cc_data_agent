/* ChatApp — core class, constructor, send/WS/streaming/event dispatch.
 *
 * Other /static/js modules extend ChatApp.prototype via Object.assign, so
 * this file must load FIRST (after marked.min.js). The global `app` instance
 * is created in init.js once all mixins have registered their methods.
 */

class ChatApp {
  constructor() {
    this.sessionId = null;
    this.ws = null;
    this.streaming = false;
    this._textBuf = '';
    this._thinkBuf = '';
    this._curMsgEl = null;
    this._thinkEl = null;
    this._thinkScrollPending = false;
    this._toolSummary = null;
    this._toolSummaryEl = null;
    this._toolCounter = 0;
    this._approvalEl = null;
    this._activityEl = null;
    this._pendingApproval = false;
    this._authed = false;
    this._authMode = 'login';   // or 'register'
    this._sessions = [];        // last fetched list (for search filter)
    this._user = null;
    this._pendingImage = null;   // base64 data URL of attached image
    this._pendingFiles = [];     // non-image attachments sent with the next prompt
    this._yolo = false;          // YOLO mode — auto-approve all tool calls
    this._permissionMode = 'accept-all';
    this._turnActive = false;    // true during a turn, false after finishTurn
    this._wsReconnected = false; // true during WS reconnect replay guard
    this._batchScroll = false;   // suppress per-item scroll while loading history
    this._setupImageHandlers();
    this._setupVisibilityFlush();
  }

  // ── Send prompt ─────────────────────────────────────────────────

  async _ensureSession() {
    if (this.sessionId) return this.sessionId;
    const r = await this._fetchAuth('/api/prompt', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({prompt: '', session_id: ''})
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `Server error (${r.status})`);
    this.sessionId = data.session_id;
    try {
      await this._fetchAuth('/api/config', {
        method: 'PATCH',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          session_id: this.sessionId,
          config: {
            permission_mode: this._permissionMode || (this._yolo ? 'accept-all' : 'auto'),
          },
        }),
      });
    } catch(e) { /* non-fatal */ }
    const fid = this._getActiveFolderId && this._getActiveFolderId();
    if (fid) {
      try {
        await this._fetchAuth(`/api/sessions/${data.session_id}/folder`, {
          method: 'PATCH',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({folder_id: fid}),
        });
      } catch(e) { /* non-fatal */ }
    }
    this._connectWS(this.sessionId);
    this.loadSessions();
    return this.sessionId;
  }

  async send() {
    const input = document.getElementById('prompt-input');
    const text = input.value.trim();
    if (!text) return;
    if (this._pendingFiles.some((f) => f.status === 'uploading')) {
      this._addError('Please wait for file uploads to finish.');
      return;
    }
    input.value = '';
    input.style.height = 'auto';

    // Reset tool summary for this turn — each question gets its own card
    this._toolSummary = null;
    this._toolSummaryEl = null;

    let restoreAttachments = () => {};
    try {
      await this._ensureSession();

      // Include attached image if present (capture BEFORE adding bubble)
      const imgData = this._pendingImage;
      const attachments = this._pendingFiles.slice();
      this._pendingImage = null;
      this._pendingFiles = [];
      this._renderAttachmentPreview();
      restoreAttachments = () => {
        this._pendingImage = imgData;
        this._pendingFiles = attachments.slice();
        this._renderAttachmentPreview();
      };

      this._addUserBubble(text, imgData, attachments);
      this._turnActive = true;
      this._showActivity('', 'Processing', 'connecting...');
      this._scrollBottom();

      // Slash commands
      if (text.startsWith('/')) {
        const longRunning = ['/brainstorm','/worker','/plan','/agent'];
        const isLong = longRunning.some(c => text === c || text.startsWith(c + ' '));
        if (isLong) {
          this._showActivity('', 'Running', text.split(' ')[0] + '...');
          this._runSlashSSE(text, imgData, attachments);
        } else {
          this._showActivity('', 'Running', text.split(' ')[0] + '...');
          const r = await this._fetchAuth('/api/prompt', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({
              prompt: text,
              session_id: this.sessionId,
              image: imgData || undefined,
              attachment_tokens: attachments.length ? attachments.map(a => a.token) : undefined,
            })
          });
          const data = await r.json();
          if (!r.ok) {
            restoreAttachments();
            this._removeActivity();
            this._addError(data.error || `Server error (${r.status})`);
            return;
          }
          this._removeActivity();
          (data.events || []).forEach(evt => this._handleEvent(evt));
          if (!this.sessionId) this.sessionId = data.session_id;
        }
        return;
      }

      // Regular prompts — prefer WS
      await this._ensureWS();
      const wsOK = this.ws && this.ws.readyState === 1;
      if (wsOK) {
        this._showActivity('', 'Processing', 'sending to agent...');
        const payload = {type: 'prompt', prompt: text};
        if (imgData) payload.image = imgData;
        if (attachments.length) payload.attachment_tokens = attachments.map(a => a.token);
        this.ws.send(JSON.stringify(payload));
      } else {
        this._showActivity('', 'Processing', 'sending (http)...');
        const r = await this._fetchAuth('/api/prompt', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            prompt: text,
            session_id: this.sessionId,
            image: imgData || undefined,
            attachment_tokens: attachments.length ? attachments.map(a => a.token) : undefined,
          })
        });
        if (!r.ok) {
          restoreAttachments();
          const data = await r.json();
          this._addError(data.error || `Server error (${r.status})`);
          return;
        }
        this._pollForResult();
      }
    } catch(e) {
      restoreAttachments();
      input.value = text;
      this._addError('Failed to send: ' + e.message);
    }
  }

  _pollForResult() {
    if (this._polling) return;
    this._polling = true;
    this._pollCount = 0;
    this.setStatus('running');
    this._showActivity('', 'Working', 'waiting for response...');
    const poll = async () => {
      this._pollCount++;
      try {
        const r = await fetch(`/api/sessions/${this.sessionId}`, {credentials:'same-origin'});
        if (!r.ok) { this._polling = false; this._removeActivity(); return; }
        const data = await r.json();
        const secs = this._pollCount * 2;
        this._showActivity('', 'Working',
          data.busy ? `running... (${secs}s)` : 'finishing...');
        if (!data.busy) {
          this._polling = false;
          this._removeActivity();
          this.setStatus('idle');
          const msgs = data.messages || [];
          const last = msgs[msgs.length - 1];
          if (last && last.role === 'assistant') {
            this._addAssistantBubble(last.content);
            if (last.tool_calls) last.tool_calls.forEach(tc => {
              this._addToolCard(tc.name, tc.inputs, tc.status, tc.result);
            });
            this._closeToolSummary();
          }
          this.loadSessions();
          if (this.sessionId && (!this.ws || this.ws.readyState !== 1)) {
            this._connectWS(this.sessionId);
          }
          return;
        }
      } catch(e) { /* ignore */ }
      if (this._polling) setTimeout(poll, 2000);
    };
    setTimeout(poll, 2000);
  }

  // ── WebSocket ────────────────────────────────────────────────────

  _connectWS(sid) {
    this._disconnectWS();
    this._wsRetries = (this._wsRetries || 0);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/api/events`;
    try {
      this.ws = new WebSocket(url);
    } catch(e) {
      console.warn('[chat] WebSocket constructor failed:', e);
      this.setStatus('no-ws');
      return;
    }
    this._wsSessionId = sid;

    this.ws.onopen = () => {
      this._wsRetries = 0;
      this._wsReconnected = true;
      this.ws.send(JSON.stringify({session_id: sid}));
      this.setStatus('connected');
    };
    this.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.error) {
          console.warn('[chat] WS server error:', data.error);
          return;
        }
        this._handleEvent(data);
      } catch(err) { console.error('[chat] ws parse:', err); }
    };
    this.ws.onclose = (ev) => {
      if (ev.code === 1000) {
        this.setStatus('idle');
        return;
      }
      if (this._wsSessionId && this.sessionId === this._wsSessionId) {
        const delay = Math.min(1000 * Math.pow(2, this._wsRetries), 10000);
        this._wsRetries++;
        this.setStatus(this._wsRetries <= 2 ? 'connecting...' : 'reconnecting...');
        setTimeout(() => {
          if (this.sessionId === this._wsSessionId) {
            this._connectWS(this._wsSessionId);
          }
        }, delay);
      } else {
        this.setStatus('idle');
      }
    };
    this.ws.onerror = () => {};
  }

  _disconnectWS() {
    if (this.ws) { try { this.ws.close(); } catch(e){} this.ws = null; }
  }

  _runSlashSSE(cmd, imgData, attachments = []) {
    const body = JSON.stringify({
      prompt: cmd,
      session_id: this.sessionId || '',
      image: imgData || undefined,
      attachment_tokens: attachments.length ? attachments.map(a => a.token) : undefined,
    });
    const restoreAttachments = () => {
      this._pendingImage = imgData;
      this._pendingFiles = attachments.slice();
      this._renderAttachmentPreview();
    };
    let watchdogTimer = null;
    const startWatchdog = () => {
      clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        this._removeActivity();
        this._addError('SSE stream timed out — connection may have been lost. Please retry.');
        this._turnActive = false;
        this.setStatus('idle');
      }, 120000); // 2 minute timeout
    };
    const stopWatchdog = () => { clearTimeout(watchdogTimer); watchdogTimer = null; };
    fetch('/api/prompt', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'Content-Type': 'application/json', 'Accept': 'text/event-stream'},
      body,
    }).then(response => {
      if (!response.ok) {
        restoreAttachments();
        this._removeActivity();
        stopWatchdog();
        this._addError(`Server error (${response.status})`);
        return;
      }
      startWatchdog();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const processChunk = ({done, value}) => {
        if (done) {
          stopWatchdog();
          this._removeActivity();
          this.loadSessions();
          return;
        }
        startWatchdog(); // reset timer on each chunk
        buffer += decoder.decode(value, {stream: true});
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.type === 'session') {
                if (!this.sessionId) {
                  this.sessionId = evt.data.session_id;
                  this.loadSessions();
                  // Connect WebSocket so subsequent messages use WS
                  this._connectWS(this.sessionId);
                }
              } else if (evt.type === 'done') {
                this._removeActivity();
                this._closeToolSummary();
                this.loadSessions();
              } else {
                this._handleEvent(evt);
              }
            } catch(e) { /* skip bad JSON */ }
          }
        }
        reader.read().then(processChunk);
      };
      reader.read().then(processChunk);
    }).catch(err => {
      restoreAttachments();
      stopWatchdog();
      this._removeActivity();
      this._addError('Connection error: ' + err.message);
    });
  }

  _ensureWS() {
    return new Promise(resolve => {
      if (this.ws && this.ws.readyState === 1) { resolve(); return; }
      if (!this.ws || this.ws.readyState >= 2) {
        if (this.sessionId) this._connectWS(this.sessionId);
      }
      let elapsed = 0;
      const iv = setInterval(() => {
        elapsed += 50;
        if (this.ws && this.ws.readyState === 1) {
          clearInterval(iv); resolve(); return;
        }
        if (elapsed >= 3000) { clearInterval(iv); resolve(); }
      }, 50);
    });
  }

  // ── Event dispatch ──────────────────────────────────────────────

  _handleEvent(evt) {
    // Ignore stale events from WS reconnect replay (text/tool events during replay guard)
    // After WS reconnect, the server replays recent events. We skip them on first
    // reconnect until we see a turn_done or the guard clears.
    if (this._wsReconnected && (evt.type === 'text_chunk' || evt.type === 'tool_start' || evt.type === 'tool_end')) {
      return;
    }
    // Clear reconnect guard on first meaningful event
    if (evt.type === 'text_chunk' || evt.type === 'tool_start' || evt.type === 'turn_done' || evt.type === 'tool_end') {
      this._wsReconnected = false;
    }
    switch (evt.type) {
      case 'text_chunk':
        this._removeActivity();
        if (!this._curMsgEl) this._startAssistantStream();
        // Collapse thinking block when answer starts streaming
        if (this._thinkEl) this._thinkEl.open = false;
        this._textBuf += evt.data.text;
        this._renderStream();
        break;
      case 'thinking_chunk':
        this._removeActivity();
        this._thinkBuf += evt.data.text || '';
        this._renderThinking();
        break;
      case 'tool_start':
        this._removeActivity();
        this._addToolCard(evt.data.name, evt.data.inputs, 'running');
        this._showActivity('tool-running', `Running ${evt.data.name}`, '');
        break;
      case 'tool_end':
        this._removeActivity();
        this._completeToolCard(evt.data.name, evt.data.result, evt.data.permitted);
        break;
      case 'permission_request':
        this._removeActivity();
        this._showApproval(evt.data.description);
        break;
      case 'permission_response':
        this._resolveApproval(evt.data.granted);
        break;
      case 'turn_done':
        this._removeActivity();
        this._finishTurn(evt.data.input_tokens, evt.data.output_tokens);
        break;
      case 'status':
        if (evt.data.state === 'running') {
          this.setStatus('running');
          this._showActivity('', 'Processing', '');
        } else if (evt.data.state === 'idle') {
          this._removeActivity();
          this.setStatus('connected');
          this.loadSessions();
        }
        break;
      case 'command_result':
        this._removeActivity();
        this._addCommandResult(evt.data.command, evt.data.output);
        break;
      case 'interactive_menu':
        this._removeActivity();
        this._addInteractiveMenu(evt.data);
        break;
      case 'input_request':
        this._removeActivity();
        this._addInputRequest(evt.data);
        break;
      case 'error':
        this._removeActivity();
        this._addError(evt.data.message);
        break;
    }
  }

  // ── Message rendering (bubbles + streaming) ────────────────────

  _clearChat() {
    const el = document.getElementById('messages');
    el.innerHTML = '<div style="flex:1"></div>';
    this._curMsgEl = null; this._thinkEl = null; this._activityEl = null;
    this._textBuf = ''; this._thinkBuf = ''; this._toolSummary = null;
    this._toolSummaryEl = null; this._toolCounter = 0; this._approvalEl = null;
    this._pendingApproval = false; this._turnActive = false;
    this._thinkScrollPending = false; this._batchScroll = false;
  }

  _addUserBubble(text, imgDataUrl, attachments = []) {
    const el = document.createElement('div');
    el.className = 'msg user';
    let inner = '<div class="role-tag">You</div><div class="bubble">';
    if (imgDataUrl) {
      inner += `<img src="${imgDataUrl}" alt="Uploaded image" style="max-width:100%;max-height:240px;object-fit:contain;border-radius:var(--radius-sm);margin-bottom:6px;display:block">`;
    }
    if (attachments.length) {
      inner += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">';
      attachments.forEach((file) => {
        inner += `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid var(--border);border-radius:999px;background:var(--panel);font-size:12px;color:var(--text-dim)">&#128196; ${this._escapeHtml(file.name || 'file')}</span>`;
      });
      inner += '</div>';
    }
    inner += `<span></span></div>`;
    el.innerHTML = inner;
    el.querySelector('.bubble span').textContent = text;
    document.getElementById('messages').appendChild(el);
    if (!this._batchScroll) this._scrollBottom();
  }

  _addAssistantBubble(content) {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = `<div class="role-tag">Assistant</div><div class="bubble"></div>`;
    el.querySelector('.bubble').innerHTML = this._renderMd(content);
    document.getElementById('messages').appendChild(el);
    if (!this._batchScroll) this._scrollBottom();
  }

  _startAssistantStream() {
    this._removeActivity();
    this._textBuf = '';
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = `<div class="role-tag">Assistant</div><div class="bubble"></div>`;
    document.getElementById('messages').appendChild(el);
    this._curMsgEl = el.querySelector('.bubble');
    this.streaming = true;
  }

  _renderStream() {
    if (!this._curMsgEl) return;
    // Use setTimeout(0) instead of requestAnimationFrame so DOM updates
    // continue even when the tab is backgrounded (rAF is paused by browsers
    // for hidden tabs, which caused the UI to freeze while _textBuf grows,
    // then _curMsgEl gets nulled by _finishTurn before the user sees anything).
    if (!this._rafPending) {
      this._rafPending = true;
      const doRender = () => {
        this._rafPending = false;
        if (this._curMsgEl) {
          this._curMsgEl.innerHTML = this._renderMd(this._textBuf);
          this._scrollBottom();
        }
      };
      // Use setTimeout for background-tab safety; fall back to rAF when visible
      // for smoother rendering (only queue one or the other).
      if (document.hidden) {
        setTimeout(doRender, 0);
      } else {
        requestAnimationFrame(doRender);
      }
    }
  }

  _renderThinking() {
    if (!this._thinkBuf) return;
    if (!this._thinkEl) {
      const el = document.createElement('details');
      el.className = 'thinking-block';
      el.innerHTML = `<summary><span class="thinking-icon">&#129504;</span> Thinking</summary>
        <div class="thinking-body"></div>`;
      el.open = true;
      document.getElementById('messages').appendChild(el);
      this._thinkEl = el;
    }
    this._thinkEl.querySelector('.thinking-body').textContent = this._thinkBuf;
    // Scroll on every chunk so the growing thinking block stays in view.
    // Use the same rAF-throttle pattern as _renderStream.
    if (!this._thinkScrollPending) {
      this._thinkScrollPending = true;
      const scroll = () => {
        this._thinkScrollPending = false;
        this._scrollBottom();
      };
      if (document.hidden) {
        setTimeout(scroll, 0);
      } else {
        requestAnimationFrame(scroll);
      }
    }
  }

  // ── Page-visibility flush ──────────────────────────────────
  // When user returns to a backgrounded tab, flush any buffered stream
  // text that rAF may have skipped while hidden.
  _setupVisibilityFlush() {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this._textBuf && this._curMsgEl) {
        this._curMsgEl.innerHTML = this._renderMd(this._textBuf);
        this._scrollBottom();
      }
    });
  }

  // ── Image upload / paste / drag ───────────────────────────────
  _setupImageHandlers() {
    // File input button (camera icon in input row)
    const fileInput = document.getElementById('img-file-input');
    if (fileInput) {
      fileInput.addEventListener('change', () => {
        if (fileInput.files && fileInput.files.length) {
          this._handleAttachmentFiles(Array.from(fileInput.files));
        }
        fileInput.value = '';
      });
    }

    // Paste from clipboard (Ctrl+V / Cmd+V)
    const promptInput = document.getElementById('prompt-input');
    if (promptInput) {
      promptInput.addEventListener('paste', (e) => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            e.preventDefault();
            const blob = item.getAsFile();
            if (blob) this._handleAttachmentFiles([blob]);
            return;
          }
        }
      });
    }

    // Drag-and-drop onto input area
    const inputArea = document.getElementById('input-area');
    if (inputArea) {
      inputArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        inputArea.style.borderColor = 'var(--accent)';
      });
      inputArea.addEventListener('dragleave', () => {
        inputArea.style.borderColor = '';
      });
      inputArea.addEventListener('drop', (e) => {
        e.preventDefault();
        inputArea.style.borderColor = '';
        const files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length > 0) {
          this._handleAttachmentFiles(Array.from(files));
        }
      });
    }
  }

  _handleAttachmentFiles(files) {
    files.forEach((file) => this._handleAttachmentFile(file));
  }

  async _handleAttachmentFile(file) {
    if (!file) return;
    const parts = (file.name || '').split('.');
    const ext = parts.length > 1 ? String(parts.pop() || '').toLowerCase() : '';
    const supported = file.type.startsWith('image/') || ['pdf', 'csv', 'tsv', 'xlsx', 'xls', 'txt', 'md', 'json'].includes(ext);
    if (!supported) {
      this._addError(`Unsupported attachment: ${file.name}`);
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      this._addError(`${file.name} is too large — max 25 MB`);
      return;
    }
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        this._pendingImage = e.target.result;
        this._renderAttachmentPreview();
      };
      reader.readAsDataURL(file);
      return;
    }

    const localId = `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    this._pendingFiles.push({
      localId,
      name: file.name,
      size: file.size,
      status: 'uploading',
    });
    this._renderAttachmentPreview();
    try {
      await this._ensureSession();
      const uploaded = await this._uploadAttachment(file);
      this._pendingFiles = this._pendingFiles.map((item) =>
        item.localId === localId ? {...uploaded, status: 'ready'} : item
      );
      this._renderAttachmentPreview();
    } catch(e) {
      this._pendingFiles = this._pendingFiles.filter((item) => item.localId !== localId);
      this._renderAttachmentPreview();
      this._addError(`Upload failed for ${file.name}: ${e.message}`);
    }
  }

  _csrfTokenFromCookie() {
    const match = document.cookie.match(/(?:^|; )ccsrf=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  _uploadAttachment(file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/uploads', true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('X-Session-Id', this.sessionId || '');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'attachment'));
      xhr.setRequestHeader('X-File-Type', file.type || this._guessAttachmentMime(file.name));
      const csrf = this._csrfTokenFromCookie();
      if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText || '{}'); } catch(e) {}
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data.attachment || {});
        } else {
          reject(new Error(data.error || `Server error (${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new Error('network error'));
      xhr.send(file);
    });
  }

  _guessAttachmentMime(name) {
    const parts = (name || '').split('.');
    const ext = parts.length > 1 ? String(parts.pop() || '').toLowerCase() : '';
    const mimeMap = {
      pdf: 'application/pdf',
      csv: 'text/csv',
      tsv: 'text/tab-separated-values',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls: 'application/vnd.ms-excel',
      txt: 'text/plain',
      md: 'text/markdown',
      json: 'application/json',
    };
    return mimeMap[ext] || 'application/octet-stream';
  }

  _renderAttachmentPreview() {
    const bar = document.getElementById('img-preview-bar');
    if (!bar) return;
    bar.innerHTML = '';
    const btn = document.getElementById('img-btn');
    const hasAttachments = !!this._pendingImage || this._pendingFiles.length > 0;
    if (!hasAttachments) {
      bar.classList.remove('has-img');
      if (btn) btn.classList.remove('has-img');
      return;
    }

    bar.classList.add('has-img');
    if (btn) btn.classList.add('has-img');

    if (this._pendingImage) {
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      const img = document.createElement('img');
      img.src = this._pendingImage;
      img.alt = 'Preview';
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-img';
      removeBtn.innerHTML = '&times;';
      removeBtn.onclick = () => this._clearPendingImage();
      thumb.appendChild(img);
      thumb.appendChild(removeBtn);
      bar.appendChild(thumb);
      const label = document.createElement('span');
      label.className = 'img-label';
      label.textContent = 'image';
      bar.appendChild(label);
    }

    this._pendingFiles.forEach((file, idx) => {
      const chip = document.createElement('div');
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--border);border-radius:999px;background:var(--panel);font-size:12px;color:var(--text);';
      const label = document.createElement('span');
      const suffix = file.status === 'uploading' ? ' (uploading...)' : '';
      label.textContent = `${file.name || `file-${idx + 1}`}${suffix}`;
      const removeBtn = document.createElement('button');
      removeBtn.innerHTML = '&times;';
      removeBtn.style.cssText = 'border:none;background:transparent;color:var(--text-dim);cursor:pointer;font-size:14px;line-height:1;';
      removeBtn.onclick = () => this._removePendingFile(idx);
      chip.appendChild(label);
      chip.appendChild(removeBtn);
      bar.appendChild(chip);
    });
  }

  _clearPendingImage() {
    this._pendingImage = null;
    this._renderAttachmentPreview();
  }

  _removePendingFile(idx) {
    this._pendingFiles.splice(idx, 1);
    this._renderAttachmentPreview();
  }

  _closeToolSummary() {
    if (this._toolSummaryEl) this._toolSummaryEl.removeAttribute('open');
    this._toolSummary = null;
    this._toolSummaryEl = null;
  }

  _finalizeTurnSummary() {
    const thinkingText = (this._thinkBuf || '').trim();
    const toolEntries = Array.isArray(this._toolSummary)
      ? this._toolSummary.map((entry) => ({...entry}))
      : [];
    const hasThinking = !!thinkingText;
    const hasTools = toolEntries.length > 0;
    if (!hasThinking && !hasTools) return;

    const card = document.createElement('details');
    card.className = 'tool-summary-card turn-summary-card';
    card.innerHTML = `
      <summary>
        <span class="tool-arrow">&#9654;</span>
        <span class="tool-summary-icon">&#9776;</span>
        <span class="tool-summary-label">Turn summary</span>
        <span class="tool-summary-count">${hasThinking && hasTools ? 'thinking + tools' : hasThinking ? 'thinking' : `tools ${toolEntries.length}`}</span>
      </summary>
      <div class="tool-summary-body"></div>`;

    const body = card.querySelector('.tool-summary-body');
    if (hasThinking) {
      const think = document.createElement('div');
      think.className = 'ts-row done';
      think.style.display = 'block';
      think.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <span class="ts-icon done">&#129504;</span>
          <span class="ts-name">Thinking</span>
        </div>
        <div style="white-space:pre-wrap;color:var(--text-dim);line-height:1.5;padding-left:24px;">${this._esc(thinkingText)}</div>`;
      body.appendChild(think);
    }
    if (hasThinking && hasTools) {
      const divider = document.createElement('div');
      divider.style.cssText = 'height:1px;background:var(--border);margin:10px 0;';
      body.appendChild(divider);
    }
    if (hasTools) {
      const toolsWrap = document.createElement('div');
      toolsWrap.innerHTML = toolEntries.map((e) => {
        const icon = e.status === 'running'
          ? '<span class="ts-spinner"></span>'
          : e.status === 'denied'
            ? '<span class="ts-icon denied">&#10006;</span>'
            : '<span class="ts-icon done">&#10003;</span>';
        const preview = e.inputs
          ? (typeof e.inputs === 'string' ? e.inputs : JSON.stringify(e.inputs)).split('\n')[0].slice(0, 80)
          : '';
        const resultPreview = e.result ? e.result.split('\n')[0].slice(0, 100) : '';
        return `<div class="ts-row ${this._esc(e.status || 'done')}">
          ${icon}
          <span class="ts-name">${this._esc(e.name)}</span>
          <span class="ts-preview">${this._esc(preview)}</span>
          ${resultPreview ? `<span class="ts-result">&#8594; ${this._esc(resultPreview)}</span>` : ''}
        </div>`;
      }).join('');
      body.appendChild(toolsWrap);
    }

    document.getElementById('messages').appendChild(card);
    if (this._thinkEl) this._thinkEl.remove();
    if (this._toolSummaryEl) this._toolSummaryEl.remove();
  }

  _finishTurn(tokIn, tokOut) {
    // If thinking was shown but no assistant bubble was created (text_chunks
    // were lost — e.g. after WS reconnect replay guard drops them), fetch the
    // complete result from the server so the user isn't stuck on the thinking block.
    const needsRecover = this._thinkBuf && !this._curMsgEl && this.sessionId;

    this._removeActivity();
    this.streaming = false;
    this._finalizeTurnSummary();
    this._curMsgEl = null;
    this._thinkEl = null;
    this._thinkBuf = '';
    this._textBuf = '';
    this._turnActive = false;
    this._closeToolSummary();

    if (needsRecover) {
      this._recoverLastTurn();
    }

    if (tokIn || tokOut) {
      const meta = document.createElement('div');
      meta.className = 'turn-meta';
      meta.textContent = `${(tokIn||0).toLocaleString()} tokens in / ${(tokOut||0).toLocaleString()} tokens out`;
      document.getElementById('messages').appendChild(meta);
    }
    this._scrollBottom();
  }

  async _recoverLastTurn() {
    try {
      const r = await this._fetchAuth(`/api/sessions/${this.sessionId}`);
      const data = await r.json();
      const msgs = data.messages || [];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        this._addAssistantBubble(last.content);
        if (last.tool_calls) {
          last.tool_calls.forEach(tc => {
            this._addToolCard(tc.name, tc.inputs, tc.status, tc.result);
          });
          this._closeToolSummary();
        }
      }
    } catch(e) {
      console.warn('[chat] _recoverLastTurn failed:', e);
    }
  }

  _addError(msg) {
    const el = document.createElement('div');
    el.style.cssText = 'color:var(--red);font-size:13px;padding:8px 12px;background:var(--red-dim);border-radius:var(--radius-sm);margin:8px 0;max-width:min(640px,90%)';
    el.textContent = msg;
    document.getElementById('messages').appendChild(el);
    this._scrollBottom();
  }

  setYolo(on) {
    this._yolo = on;
    const btn = document.getElementById('yolo-btn');
    if (btn) {
      btn.classList.toggle('on', on);
      btn.textContent = on ? 'YOLO ✓' : 'YOLO';
    }
    const sel = document.getElementById('sp-permission');
    if (sel) sel.value = this._permissionMode || (on ? 'accept-all' : 'auto');
  }

  async toggleYolo() {
    const next = !this._yolo;
    const newMode = next ? 'accept-all' : 'auto';
    this._permissionMode = newMode;
    this.setYolo(next);
    // Persist to server
    if (this.sessionId) {
      try {
        await this._fetchAuth('/api/config', {
          method: 'PATCH',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({session_id: this.sessionId, config: {permission_mode: newMode}}),
        });
      } catch(e) { console.error('yolo:', e); }
    }
  }

  setStatus(state) {
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');
    dot.className = 'dot' + (state==='disconnected'?' off':'') + (state==='running'?' busy':'');
    txt.textContent = state;
  }
}
