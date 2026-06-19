'use strict';

// Per-endpoint advisory locks. One file per claimed forward endpoint under
// paths.lockDir(), created with O_EXCL so the claim is atomic across processes.
// A dead holder's lock is stale and stolen; a live holder is a conflict. Zero
// runtime dependencies (fs only).

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

function keyFile(key) {
  return path.join(paths.lockDir(), Buffer.from(key).toString('base64url') + '.lock');
}

// True if pid refers to a live process. EPERM means it exists but isn't ours
// (still alive); ESRCH/EINVAL/etc. mean it's gone.
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// Claim one key. Returns { ok:true } or { ok:false, holder }. Throws only on an
// unexpected fs failure (caller fails open).
function claimOne(key, owner) {
  const file = keyFile(key);
  const payload = JSON.stringify({ pid: owner.pid, name: owner.name, ts: Date.now() });
  try {
    fs.writeFileSync(file, payload, { flag: 'wx' }); // wx == O_CREAT|O_EXCL
    return { ok: true };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { holder = null; }
    if (holder && pidAlive(holder.pid)) return { ok: false, holder };
    // stale (dead or unreadable holder) -> steal by overwriting.
    fs.writeFileSync(file, payload);
    return { ok: true };
  }
}

// Acquire ALL keys or none. owner = { name, pid }.
function acquire(keys, owner) {
  fs.mkdirSync(paths.lockDir(), { recursive: true }); // throws -> caller fails open
  const claimed = [];
  for (const key of keys) {
    let r;
    try {
      r = claimOne(key, owner);
    } catch (e) {
      for (const k of claimed) { try { fs.unlinkSync(keyFile(k)); } catch (_) {} }
      throw e;
    }
    if (!r.ok) {
      for (const k of claimed) { try { fs.unlinkSync(keyFile(k)); } catch (_) {} }
      return { ok: false, key, holder: r.holder };
    }
    claimed.push(key);
  }
  return { ok: true, handle: { keys: claimed } };
}

function release(handle) {
  if (!handle || !handle.keys) return;
  for (const key of handle.keys) { try { fs.unlinkSync(keyFile(key)); } catch (_) {} }
}

module.exports = { acquire, release };
