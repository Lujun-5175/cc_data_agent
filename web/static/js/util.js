/* Small helpers shared across ChatApp modules. */

Object.assign(ChatApp.prototype, {
  _setupAutoScrollGuard() {
    const el = document.getElementById('messages');
    if (!el || this._autoScrollGuardReady) return;
    this._autoScrollGuardReady = true;
    el.addEventListener('scroll', () => {
      if (this._programmaticScroll) return;
      this._autoScrollEnabled = this._isNearBottom();
    }, {passive: true});
  },

  _isNearBottom() {
    const el = document.getElementById('messages');
    if (!el) return true;
    return (el.scrollHeight - el.scrollTop - el.clientHeight) <= (this._autoScrollThreshold || 80);
  },

  _escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  },

  _esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  },

  _fmtRelTime(epochSec) {
    if (!epochSec) return '';
    const diff = Date.now() / 1000 - epochSec;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
    if (diff < 86400 * 7) return `${Math.floor(diff/86400)}d ago`;
    return new Date(epochSec * 1000).toLocaleDateString();
  },

  _scrollBottom(force = false) {
    const el = document.getElementById('messages');
    if (!el) return;
    if (!force && !this._autoScrollEnabled) return;
    // Use instant scroll — CSS scroll-behavior:smooth causes all programmatic
    // scrollTop assignments to animate, creating visible "jumps" when multiple
    // events (thinking_chunk + status transitions) fire in quick succession.
    requestAnimationFrame(() => {
      this._programmaticScroll = true;
      const prev = el.style.scrollBehavior;
      el.style.scrollBehavior = 'auto';
      el.scrollTop = el.scrollHeight;
      el.style.scrollBehavior = prev;
      this._programmaticScroll = false;
      this._autoScrollEnabled = true;
    });
  },

  _renderMd(text) {
    try {
      // Strip raw HTML tags before passing to marked, so that model output
      // can't inject <script>/<img onerror> through markdown.
      const clean = (text || '').replace(/<\/?[a-zA-Z][^>]*>/g, (tag) =>
        tag.replace(/</g, '&lt;').replace(/>/g, '&gt;')
      );
      const html = marked.parse(clean, {breaks: true});
      const root = document.createElement('div');
      root.innerHTML = html;
      root.querySelectorAll('table').forEach((table) => {
        const wrap = document.createElement('div');
        wrap.className = 'md-table-wrap';
        table.parentNode.insertBefore(wrap, table);
        wrap.appendChild(table);
      });
      return root.innerHTML;
    } catch(e) { return this._esc(text); }
  },
});
