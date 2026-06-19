'use strict';

// Tunnel-selection helpers: turn a name / repeated --tag into target tunnels,
// and reload the daemon when config changes while it's running. Imports shared
// primitives from cli-core and daemonPing from daemon-control; never requires ./cli.

const config = require('./config');
const paths = require('./paths');
const ipc = require('./ipc');
const { EXIT } = require('./cli-core');
const { daemonPing } = require('./daemon-control');

function selectTunnels(cfg, name) {
  if (!name || name === 'all') return cfg.tunnels;
  const t = config.findTunnel(cfg, name);
  return t ? [t] : [];
}

// Tunnels carrying any of the given tags (union). Empty `tags` matches nothing.
function tunnelsByTag(cfg, tags) {
  const want = new Set(tags);
  return cfg.tunnels.filter((t) => (t.tags || []).some((x) => want.has(x)));
}

// Resolve a `[name]` positional + repeated `--tag` flag into target tunnels for
// the selecting verbs. name and --tag are mutually exclusive; the literal name
// `all` (a reserved tunnel name) selects every tunnel. Returns { targets, tags }
// on success, or { error, code } to report and exit.
//   - bad tag chars            -> usage (2)
//   - name AND --tag together  -> usage (2)
//   - requireTarget + neither  -> usage (2)   (the action verbs: enable/disable/restart)
//   - --tag matches nothing    -> not-found (3)
//   - name matches nothing     -> not-found (3)
//   - neither given            -> all tunnels (tags: [])  unless requireTarget
// opts.requireTarget: action verbs that change/bounce tunnels must name what they
// act on (a name, --tag, or `all`) — bare is a usage error, not a silent "all".
function resolveSelection(cfg, name, tagFlag, opts = {}) {
  let tags;
  try { tags = config.parseTags(tagFlag); } catch (e) { return { error: e.message, code: EXIT.USAGE }; }
  if (tags.length && name) return { error: 'give a tunnel name or --tag, not both', code: EXIT.USAGE };
  if (tags.length) {
    const targets = tunnelsByTag(cfg, tags);
    if (!targets.length) return { error: `no tunnels tagged ${tags.map((x) => `"${x}"`).join(', ')}`, code: EXIT.NOTFOUND };
    return { targets, tags };
  }
  if (!name && opts.requireTarget) {
    return { error: 'specify a tunnel name, --tag <label>, or `all`', code: EXIT.USAGE };
  }
  const targets = selectTunnels(cfg, name);
  if (name && name !== 'all' && !targets.length) return { error: `no such tunnel: ${name}`, code: EXIT.NOTFOUND };
  return { targets, tags: [] };
}

// Reload the daemon if it's up. Returns true if it reloaded, false if down.
async function reloadIfRunning() {
  const ping = await daemonPing();
  if (!ping) return false;
  try { await ipc.request(paths.socketPath(), 'reload', {}); } catch (_) {}
  return true;
}

module.exports = { selectTunnels, tunnelsByTag, resolveSelection, reloadIfRunning };
