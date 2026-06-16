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
  if (!name) return cfg.tunnels;
  const t = config.findTunnel(cfg, name);
  return t ? [t] : [];
}

// Tunnels carrying any of the given tags (union). Empty `tags` matches nothing.
function tunnelsByTag(cfg, tags) {
  const want = new Set(tags);
  return cfg.tunnels.filter((t) => (t.tags || []).some((x) => want.has(x)));
}

// Resolve a `[name]` positional + repeated `--tag` flag into target tunnels for
// the selecting verbs. name and --tag are mutually exclusive. Returns
// { targets, tags } on success, or { error, code } to report and exit.
//   - bad tag chars            -> usage (2)
//   - name AND --tag together  -> usage (2)
//   - --tag matches nothing    -> not-found (3)
//   - name matches nothing     -> not-found (3)
//   - neither given            -> all tunnels (tags: [])
function resolveSelection(cfg, name, tagFlag) {
  let tags;
  try { tags = config.parseTags(tagFlag); } catch (e) { return { error: e.message, code: EXIT.USAGE }; }
  if (tags.length && name) return { error: 'give a tunnel name or --tag, not both', code: EXIT.USAGE };
  if (tags.length) {
    const targets = tunnelsByTag(cfg, tags);
    if (!targets.length) return { error: `no tunnels tagged ${tags.map((x) => `"${x}"`).join(', ')}`, code: EXIT.NOTFOUND };
    return { targets, tags };
  }
  const targets = selectTunnels(cfg, name);
  if (name && !targets.length) return { error: `no such tunnel: ${name}`, code: EXIT.NOTFOUND };
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
