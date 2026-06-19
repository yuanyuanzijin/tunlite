'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Marker that wraps the line we add to a posix rc file, so install is idempotent
// and uninstall can strip exactly our block and nothing else.
const MARK_BEGIN = '# >>> tunlite completion >>>';
const MARK_END = '# <<< tunlite completion <<<';
const SHELLS = ['bash', 'zsh', 'fish'];

// Best-effort detection from $SHELL; returns a supported shell name or null.
function detectShell(env = process.env) {
  const sh = (env.SHELL || '').split('/').pop();
  return SHELLS.includes(sh) ? sh : null;
}

// Where each shell's completion lands. zsh/bash use the interactive rc file;
// fish autoloads its completions dir, so it gets a standalone file.
function rcPath(shell, home = os.homedir()) {
  switch (shell) {
    case 'zsh': return path.join(home, '.zshrc');
    case 'bash': return path.join(home, '.bashrc');
    case 'fish': return path.join(home, '.config', 'fish', 'completions', 'tunlite.fish');
    default: throw new Error(`unsupported shell "${shell}" (use: bash, zsh, fish)`);
  }
}

// The marker-wrapped block appended to a posix rc file.
function block(shell) {
  return `${MARK_BEGIN}\neval "$(tunlite completion ${shell})"\n${MARK_END}\n`;
}

// Remove our marker block from rc text, collapsing the surrounding blank lines.
// Returns { text, removed }. Leaves text untouched if the block isn't present.
function stripBlock(text) {
  const i = text.indexOf(MARK_BEGIN);
  if (i === -1) return { text, removed: false };
  const j = text.indexOf(MARK_END, i);
  if (j === -1) return { text, removed: false }; // malformed — don't guess
  const end = j + MARK_END.length;
  let before = text.slice(0, i).replace(/\n+$/, '\n');
  if (before === '\n') before = '';
  const after = text.slice(end).replace(/^\n+/, '');
  return { text: before + after, removed: true };
}

// Wire completion for `shell`. zsh/bash get the marker block appended (replacing
// any prior one); fish gets its completions file written. Returns
// { shell, path, action: 'added'|'updated', reload }.
function installInto(shell, { home = os.homedir() } = {}) {
  if (shell === 'fish') {
    const p = rcPath('fish', home);
    const existed = fs.existsSync(p);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, script('fish'));
    return { shell, path: p, action: existed ? 'updated' : 'added', reload: 'open a new shell' };
  }
  const p = rcPath(shell, home);
  let body = '';
  try { body = fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const had = body.includes(MARK_BEGIN);
  const base = stripBlock(body).text.replace(/\n+$/, '');
  fs.writeFileSync(p, (base ? base + '\n\n' : '') + block(shell));
  return { shell, path: p, action: had ? 'updated' : 'added', reload: `exec ${shell}` };
}

// Undo installInto. zsh/bash: strip the marker block. fish: delete the file (only
// if it's ours). Returns { shell, path, removed }.
function removeFrom(shell, { home = os.homedir() } = {}) {
  const p = rcPath(shell, home);
  if (shell === 'fish') {
    try {
      if (fs.readFileSync(p, 'utf8').includes('tunlite')) { fs.unlinkSync(p); return { shell, path: p, removed: true }; }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { shell, path: p, removed: false };
  }
  let body;
  try { body = fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { shell, path: p, removed: false }; throw e; }
  const { text, removed } = stripBlock(body);
  if (removed) fs.writeFileSync(p, text);
  return { shell, path: p, removed };
}

// Single source of truth for shell completion: the user-facing verbs, and the
// subset whose first positional is a tunnel name.
const COMMANDS = [
  'add', 'set', 'rm', 'rename', 'list',
  'enable', 'disable', 'restart', 'run',
  'status', 'monitor', 'logs', 'doctor',
  'check', 'setup-key',
  'webhook', 'export', 'import',
  'update', 'install', 'uninstall',
  'daemon', 'version', 'help',
];

const NAME_COMMANDS = ['enable', 'disable', 'restart', 'status', 'logs', 'rm', 'rename', 'set', 'doctor'];

// Tunnel names straight from config (no daemon). The generated scripts call
// `tunlite completion names` to populate name-argument candidates.
function tunnelNames(configFile) {
  try {
    return config.load(configFile).tunnels.map((t) => t.name);
  } catch (_) {
    return [];
  }
}

function bashScript() {
  return `# tunlite bash completion. Load with:  eval "$(tunlite completion bash)"
_tunlite() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local commands="${COMMANDS.join(' ')}"
  local name_cmds=" ${NAME_COMMANDS.join(' ')} "
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "\$commands" -- "\$cur") )
    return 0
  fi
  local cmd="\${COMP_WORDS[1]}"
  if [ "\$COMP_CWORD" -eq 2 ] && [[ "\$name_cmds" == *" \$cmd "* ]]; then
    COMPREPLY=( \$(compgen -W "\$(tunlite completion names 2>/dev/null)" -- "\$cur") )
    return 0
  fi
  return 0
}
complete -F _tunlite tunlite
complete -F _tunlite tun
`;
}

function zshScript() {
  return `#compdef tunlite
# tunlite zsh completion. Load with:  tunlite completion zsh > "\${fpath[1]}/_tunlite"
_tunlite() {
  local -a commands
  commands=(${COMMANDS.join(' ')})
  local name_cmds=" ${NAME_COMMANDS.join(' ')} "
  if (( CURRENT == 2 )); then
    compadd -- $commands
    return
  fi
  if (( CURRENT == 3 )) && [[ "$name_cmds" == *" \${words[2]} "* ]]; then
    compadd -- \${(f)"$(tunlite completion names 2>/dev/null)"}
    return
  fi
}
compdef _tunlite tunlite tun
`;
}

function fishScript() {
  return `# tunlite fish completion. Load with:
#   tunlite completion fish > ~/.config/fish/completions/tunlite.fish
function __tunlite_names
    tunlite completion names 2>/dev/null
end
set -l __tunlite_cmds ${COMMANDS.join(' ')}
for __tc in tunlite tun
    complete -c $__tc -f
    complete -c $__tc -n "not __fish_seen_subcommand_from $__tunlite_cmds" -a "$__tunlite_cmds"
    complete -c $__tc -n "__fish_seen_subcommand_from ${NAME_COMMANDS.join(' ')}" -a "(__tunlite_names)"
end
`;
}

function script(shell) {
  switch (shell) {
    case 'bash': return bashScript();
    case 'zsh': return zshScript();
    case 'fish': return fishScript();
    default: throw new Error(`unsupported shell "${shell}" (use: bash, zsh, fish)`);
  }
}

module.exports = { COMMANDS, NAME_COMMANDS, tunnelNames, script, detectShell, rcPath, installInto, removeFrom, MARK_BEGIN, MARK_END };
