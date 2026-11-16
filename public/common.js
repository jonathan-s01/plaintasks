(() => {
  'use strict';

  const token = document.querySelector('meta[name="plaintasks-token"]').content;

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: { 'X-Plaintasks-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON error */
    }
    if (!res.ok) {
      const err = new Error((data && data.message) || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = data && data.code;
      throw err;
    }
    return data;
  }

  let flip = false;
  // Alternating a trailing no-break space makes screen readers re-announce identical messages.
  function announce(message) {
    const live = document.getElementById('live');
    flip = !flip;
    live.textContent = message + (flip ? '' : '\u00a0');
  }

  function alertMessage(message) {
    const el = document.getElementById('alert');
    el.textContent = '';
    setTimeout(() => {
      el.textContent = message;
    }, 50);
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  window.PT = { api, announce, alertMessage, el, token };
})();
