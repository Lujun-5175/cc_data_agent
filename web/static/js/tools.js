/* Tool cards (aggregated into one summary card), activity spinner,
 * slash-command results, input requests, interactive menus. */

Object.assign(ChatApp.prototype, {

  _addToolCard(name, inputs, status, result) {
    // Buffer tool info — render all together as a single summary card
    const entry = { name, inputs, status: status || 'running', result: result || '' };
    if (!this._toolSummary) this._toolSummary = [];
    this._toolSummary.push(entry);
    this._renderToolSummary();
    this._scrollBottom();
  },

  _completeToolCard(name, result, permitted) {
    if (!this._toolSummary) return;
    const entry = this._toolSummary.find(e => e.name === name && e.status === 'running');
    if (!entry) return;
    entry.status = permitted ? 'done' : 'denied';
    entry.result = result || '';
    this._renderToolSummary();
  },

  _renderToolSummary() {
    const el = this._toolSummaryEl;
    if (!this._toolSummary || this._toolSummary.length === 0) return;

    if (!el) {
      const card = document.createElement('details');
      card.className = 'tool-summary-card';
      card.id = 'tool-summary-' + (this._toolCounter++);
      card.innerHTML = `
        <summary>
          <span class="tool-arrow">&#9654;</span>
          <span class="tool-summary-icon">&#9881;</span>
          <span class="tool-summary-label">Tool calls</span>
          <span class="tool-summary-count">0</span>
        </summary>
        <div class="tool-summary-body"></div>`;
      document.getElementById('messages').appendChild(card);
      this._toolSummaryEl = card;
      this._scrollBottom();
    }

    // Update count badge
    const total = this._toolSummary.length;
    const done = this._toolSummary.filter(e => e.status !== 'running').length;
    const badge = this._toolSummaryEl.querySelector('.tool-summary-count');
    badge.textContent = done === total ? `\u2713 ${total}` : `${done}/${total}`;
    badge.className = 'tool-summary-count' + (done === total ? ' done' : '');

    // Render tool lines
    const body = this._toolSummaryEl.querySelector('.tool-summary-body');
    body.innerHTML = this._toolSummary.map(e => {
      const isRunning = e.status === 'running';
      const icon = isRunning ? '<span class="ts-spinner"></span>'
        : e.status === 'denied' ? '<span class="ts-icon denied">\u2716</span>'
        : '<span class="ts-icon done">\u2713</span>';
      const preview = e.inputs
        ? (typeof e.inputs === 'string' ? e.inputs : JSON.stringify(e.inputs)).split('\n')[0].slice(0, 80)
        : '';
      const resultPreview = e.result
        ? e.result.split('\n')[0].slice(0, 100)
        : '';
      return `<div class="ts-row ${e.status}">
        ${icon}
        <span class="ts-name">${this._esc(e.name)}</span>
        <span class="ts-preview">${this._esc(preview)}</span>
        ${resultPreview ? `<span class="ts-result">\u2192 ${this._esc(resultPreview)}</span>` : ''}
      </div>`;
    }).join('');
  },

  _showActivity(type, label, detail) {
    if (!this._activityEl) {
      this._activityEl = document.createElement('div');
      this._activityEl.className = 'activity-indicator';
      this._activityEl.innerHTML = `
        <div class="ai-spinner"></div>
        <div class="ai-text">
          <span class="ai-label"></span>
          <span class="ai-dots"></span>
          <span class="ai-detail"></span>
        </div>
        <div class="ai-progress"><div class="ai-fill"></div></div>`;
      document.getElementById('messages').appendChild(this._activityEl);
      this._scrollBottom();
    }
    this._activityEl.className = 'activity-indicator' + (type ? ' ' + type : '');
    this._activityEl.querySelector('.ai-label').textContent = label;
    this._activityEl.querySelector('.ai-detail').textContent = detail;

    // Show dots while type is not tool-running
    const dots = this._activityEl.querySelector('.ai-dots');
    dots.style.display = (type === 'tool-running' || type === 'thinking') ? 'none' : '';
  },

  _removeActivity() {
    if (this._activityEl) {
      this._activityEl.remove();
      this._activityEl = null;
    }
  },

  _startAssistantStream() {
    this._textBuf = '';
    this._curMsgEl = document.createElement('div');
    this._curMsgEl.className = 'msg assistant';
    this._curMsgEl.innerHTML = `<div class="role-tag" style="color:var(--accent)">AI</div>
      <div class="bubble"></div>`;
    document.getElementById('messages').appendChild(this._curMsgEl);
    this._renderStream = () => {
      const bubble = this._curMsgEl.querySelector('.bubble');
      const html = marked.parse(this._textBuf, {breaks: true, gfm: true});
      bubble.innerHTML = html;
      bubble.querySelectorAll('a').forEach(a => a.target = '_blank');
    };
  },

  _addAssistantBubble(content) {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = `<div class="role-tag" style="color:var(--accent)">AI</div>
      <div class="bubble"></div>`;
    const bubble = el.querySelector('.bubble');
    if (content) {
      bubble.innerHTML = marked.parse(content, {breaks: true, gfm: true});
      bubble.querySelectorAll('a').forEach(a => a.target = '_blank');
    }
    document.getElementById('messages').appendChild(el);
    this._scrollBottom();
  },

  // ── Input request (e.g. multi-turn user input) ──────────────────

  _addInputRequest(data) {
    const el = document.createElement('div');
    el.className = 'msg assistant input-request';
    el.innerHTML = `<div class="role-tag" style="color:var(--accent)">System</div>
      <div class="bubble" style="background:var(--surface);border:1px solid var(--border);
        border-left:3px solid var(--blue);border-radius:var(--radius-sm);padding:12px 14px;">
        <div style="font-size:13px;color:var(--text);margin-bottom:8px;">${this._esc(data.prompt || 'Input required')}</div>
        <div style="display:flex;gap:6px;">
          <input type="text" id="input-request-field" style="flex:1;padding:6px 10px;
            border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);
            color:var(--text);font:inherit;font-size:13px;" placeholder="Type your response...">
          <button class="ap-btn allow" onclick="app._submitInputRequest()">Send</button>
        </div>
      </div>`;
    document.getElementById('messages').appendChild(el);
    this._scrollBottom();
    // Auto-focus the input field
    setTimeout(() => {
      const field = document.getElementById('input-request-field');
      if (field) field.focus();
    }, 100);
  },

  _submitInputRequest() {
    const field = document.getElementById('input-request-field');
    if (!field) return;
    const val = field.value.trim();
    if (!val) return;
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({type: 'input_response', value: val}));
    }
    // Remove the input card
    const card = field.closest('.input-request');
    if (card) card.remove();
  },

  // ── Interactive menu (SSJ developer mode) ─────────────────────

  _addInteractiveMenu(data) {
    const el = document.createElement('div');
    const icons = {trade:'📊',research:'🔬',code:'💻',search:'🔍',lab:'🧪',web:'🌐',brainstorm:'🧠',agent:'🤖',help:'❓'};
    const items = (data.items || []).map(it => {
      const safeCmd = this._esc(it.cmd).replace(/'/g, "\\'");
      return `
      <div class="im-item" onclick="document.getElementById('prompt-input').value='${safeCmd}';app.send()">
        <span style="font-size:16px;">${icons[it.icon]||'&#9654;'}</span>
        <div>
          <div style="font-size:12px;font-weight:600;color:var(--text);">${this._esc(it.label)}</div>
          <div style="font-size:10px;font-family:var(--mono);color:var(--text-muted);">${this._esc(it.cmd)}</div>
        </div>
      </div>`;
    }).join('');
    el.innerHTML = `<div class="role-tag" style="color:var(--accent)">SSJ Developer Mode</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;max-width:min(640px,95%);
        margin-top:6px;">${items}</div>`;
    document.getElementById('messages').appendChild(el);
    this._scrollBottom();
  },

  _addCommandResult(command, output) {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = `<div class="role-tag" style="color:var(--accent)">System</div>
      <div class="bubble" style="background:var(--surface);border:1px solid var(--border);
        border-left:3px solid var(--accent);border-radius:var(--radius-sm);padding:12px 14px;">
        <div style="font-family:var(--mono);font-size:11px;color:var(--accent);margin-bottom:6px;">${this._esc(command)}</div>
        <pre style="white-space:pre-wrap;font-family:var(--mono);font-size:12px;color:var(--text-dim);
          margin:0;background:none;border:none;padding:0;line-height:1.5;">${this._esc(output)}</pre>
      </div>`;
    document.getElementById('messages').appendChild(el);
    this._scrollBottom();
  },
});
