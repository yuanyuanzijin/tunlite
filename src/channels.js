'use strict';

// Per-IM-provider knowledge for alert delivery, isolated from *when* to alert
// (alerter.js) and the CLI. Each channel knows how to recognize its URL, render
// the neutral alert payload into the body that endpoint expects, and read the
// response to tell a real success from a silently-rejected 200.
//
// Shipped providers: `generic` and `wecom` (see KNOWN_CHANNELS below). The design
// is open for extension: to add another provider later (e.g. slack/feishu/
// dingtalk), add an entry here + its id to KNOWN_CHANNELS; alerter.js and the CLI
// do not change. Those names are extension examples, not channels that ship today.

const KNOWN_CHANNELS = ['generic', 'wecom'];

// Glyph + phrase per event. Tunnel events name the tunnel; daemon events don't.
const TUNNEL_EVENT = {
  down: ['🔴', 'is down'],
  recovered: ['✅', 'recovered'],
  'needs-auth': ['🔑', 'needs auth (passwordless broken)'],
  failed: ['❌', 'failed to start'],
  up: ['✅', 'is up'],
  stopped: ['⏹', 'stopped'],
};
const DAEMON_EVENT = {
  'daemon-up': ['✅', 'daemon started'],
  'daemon-down': ['⏹', 'daemon stopped'],
  'daemon-crash': ['🔴', 'daemon crashed (detected at restart)'],
};

// Plain-English chat message shared by IM channels.
function renderText(p) {
  let glyph;
  let head;
  if (DAEMON_EVENT[p.event]) {
    const [g, phrase] = DAEMON_EVENT[p.event];
    glyph = g;
    head = `[tunlite] ${phrase}`;
  } else if (TUNNEL_EVENT[p.event]) {
    const [g, phrase] = TUNNEL_EVENT[p.event];
    glyph = g;
    head = `[tunlite] tunnel ${p.tunnel || '(tunnel)'} ${phrase}`;
  } else {
    glyph = 'ℹ️';
    head = `[tunlite] ${p.event}`;
  }
  const lines = [`${glyph} ${head}`];
  if (p.host) lines.push(`target  ${p.host}`);
  if (p.lastError) lines.push(`error   ${p.lastError}`);
  lines.push(`machine ${p.machine}`);
  return lines.join('\n');
}

function okOn2xx(status) {
  return status >= 200 && status < 300
    ? { ok: true, detail: '' }
    : { ok: false, detail: `HTTP ${status}` };
}

const channels = {
  // The default and the fallback: today's raw JSON to any endpoint. Never
  // auto-detected (it's what `detectChannel` returns when nothing else matches).
  generic: {
    id: 'generic',
    label: 'generic',
    detect: () => false,
    format: (payload) => ({ body: payload, contentType: 'application/json' }),
    check: (status, _text) => okOn2xx(status),
  },
  // WeCom group robot: fixed {msgtype:text,text:{content}}; returns HTTP 200
  // with an errcode in the body on rejection, so success = errcode 0.
  wecom: {
    id: 'wecom',
    label: 'WeCom',
    detect: (hostname) => hostname === 'qyapi.weixin.qq.com',
    format: (payload) => ({
      body: { msgtype: 'text', text: { content: renderText(payload) } },
      contentType: 'application/json',
    }),
    check: (status, text) => {
      if (status < 200 || status >= 300) return { ok: false, detail: `HTTP ${status}` };
      let j;
      try { j = JSON.parse(text || '{}'); } catch (_) { return { ok: false, detail: 'non-JSON response' }; }
      if (j.errcode === 0) return { ok: true, detail: '' };
      return { ok: false, detail: `errcode ${j.errcode}${j.errmsg ? `: ${j.errmsg}` : ''}` };
    },
  },
};

// Mask the secret a webhook URL carries (Slack/WeCom tokens live in the path or
// query). Keep the scheme + host visible for recognizability; hide everything
// after it. '' for empty input, '(invalid)' for unparseable non-empty junk.
function redactUrl(url) {
  if (!url) return '';
  let u;
  try { u = new URL(url); } catch (_) { return '(invalid)'; }
  const base = `${u.protocol}//${u.host}`;
  const hasMore = (u.pathname && u.pathname !== '/') || u.search || u.hash;
  return hasMore ? `${base}/…` : base;
}

function resolve(id) {
  return channels[id] || channels.generic;
}

// Pick a channel id from the URL host; falls back to 'generic'.
function detectChannel(url) {
  let hostname;
  try { hostname = new URL(url).hostname; } catch (_) { return 'generic'; }
  for (const id of KNOWN_CHANNELS) {
    if (channels[id].detect(hostname)) return id;
  }
  return 'generic';
}

module.exports = { KNOWN_CHANNELS, resolve, detectChannel, renderText, redactUrl };
