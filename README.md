# modwall

A firewall for Claude Code mods: see what every mod can reach as it loads, and audit, hold or refuse it by your own policy.

![modwall demo](docs/demo.gif)

> The demo GIF at `docs/demo.gif` is not recorded yet. The image above stays broken until it is added.

## Overview

A mod is a plugin that runs code inside Claude Code with your permissions. It can read every prompt, approve or rewrite tool calls, change the system prompt, start processes and reach the network. Nothing on screen tells you which of those a mod you just installed does.

modwall hooks the `plugin.register` event, which fires each time another mod's hooks module is about to load. That event carries what Claude Code's own scanner read from the mod's source: the events it hooks, the `$` calls it makes and the environment variables it names. modwall turns that into a short reach list and a risk level, then applies your policy:

| Reach | Read from | Risk |
|---|---|---|
| `prompts` | hooks `prompt.submit`, `prompt.mention`, `session.append`, `turn.step`, `model.complete`, `classic.UserPromptSubmit`; calls `session.messages`, `model.fork` | medium |
| `network` | calls `http.*` | high |
| `processes` | calls `process.*` | high |
| `env` | calls `env.get` or `env.set` | medium |
| `secrets` | reads an env var whose name looks like a key, token, password or credential | high |
| `tool-gate` | hooks `tool.call`, `tool.check`, `classic.PreToolUse`, `classic.PermissionRequest` (can approve, refuse or rewrite tool calls) | high |
| `system-prompt` | hooks `prompt.section`, `prompt.compose`, `prompt.context`, `skill.prompt` | high |
| `file-write`, `file-read` | calls `fs.write`, `fs.read`, `fs.list`, `fs.ancestors` | medium |
| `other-mods` | hooks `plugin.register` or `engine.create` | high |
| `telemetry` | hooks `telemetry.*` | medium |

Wildcards count as everything they match, so a mod that hooks `*` is `prompts`, `tool-gate`, `system-prompt` and `other-mods` at once. A mod with none of the above (a status line, a pane) is low risk.

Three policy modes:

* `audit` (default): every mod loads. modwall records it, logs it and toasts each high-risk mod the first time it sees that mod at that version.
* `ask`: high-risk mods that are not on your allowlist are refused at load and shown as `held`. Approve one with `/modwall allow <name>` and run `/reload-plugins`. Claude Code offers no dialog while mods load, so "ask" means hold first, approve after.
* `allowlist`: every user mod not on the allowlist is refused. Entries are keyed by provenance (`name@marketplace`, or `name@inline` for `--plugin-dir`) plus version, so an update has to be approved again unless you allow `*`.

A blocklist applies in every mode. The allowlist, blocklist and a decision log (last 500 entries) are kept in modwall's `$.store`, so they survive across sessions.

## Set up

modwall can only judge mods that load after it. Claude Code loads the mods you install in the order you installed them, and `--plugin-dir` mods in the order of the flags. A mod installed before modwall loads before it and is never seen.

There are two ways to fix that:

1. **Put modwall in `prependPlugins`** (recommended where it is allowed). Add this to `~/.claude/settings.json`:

   ```json
   { "prependPlugins": ["modwall@modwall"] }
   ```

   modwall then loads in the `prepend` tier, ahead of every mod you install, and judges all of them. Claude Code reads `prependPlugins` from user settings only on a machine with no managed settings and when you are not signed in with a Team or Enterprise plan. On a managed machine, ask your administrator to list it.

2. **Install modwall first**, or reinstall the other mods after it. This depends on install order and is easy to undo by accident, so prefer option 1.

Pick the mode in `/plugin configure modwall@modwall`, in the config menu, or in settings:

```json
{ "pluginConfigs": { "modwall@modwall": { "options": { "mode": "allowlist" } } } }
```

For a `--plugin-dir` copy the key is `modwall@inline`.

## Download / Install

From the marketplace, at the prompt of a terminal session:

```
/plugin marketplace add RadTech-Solutions/modwall
/plugin install modwall@modwall
```

or in one line:

```
/plugin install modwall --marketplace RadTech-Solutions/modwall
```

Answer `y` to add the marketplace, then pick the user scope.

From a clone, for one session:

```
git clone https://github.com/RadTech-Solutions/modwall
claude --plugin-dir ./modwall --plugin-dir ./some-other-mod
```

List modwall's `--plugin-dir` before the mods it should judge.

## Usage

```
/modwall                            mods seen this session: reach, risk, decision
/modwall allow <name> [version|*]   allow a mod (a name seen this session, or name@marketplace)
/modwall block <name>               refuse a mod at every load
/modwall unblock <name>
/modwall lists                      show the allowlist and blocklist
/modwall log                        the persistent decision log
/modwall scan                       validate every installed plugin and report its footprint
```

Example `/modwall` output:

```
modwall (audit mode), 2 mod(s) seen this session:
MOD                    VERSION      RISK   DECISION         REACH
spy                    6.6.6        high   flagged          prompts, network, processes, env, secrets, tool-gate
dummy                  1.2.3        high   flagged          tool-gate, file-write, file-read
```

`/modwall scan` does not depend on load order. It runs `claude plugin list --json`, then `claude plugin validate --json <folder>` for each installed plugin, and prints each one's reach and risk, its MCP servers, and whether it carries command hooks. Use it to review what is installed, including mods that loaded before modwall.

Allowing or blocking takes effect at the next load. Run `/reload-plugins` to apply it now.

## What it can and cannot protect against

It can:

* Show you, at load, which mods can read prompts, gate tool calls, touch the network, run processes or read secrets.
* Refuse a mod before any of its code runs: no hook, no command, no tool of it joins the session.
* Pin approval to a version, so a mod that updates to new code needs approval again in `allowlist` mode.
* Fail closed: in `ask` and `allowlist` mode, if modwall's own check throws or times out, the user mod it was checking is refused.

It cannot:

* **See mods that load before it.** Without `prependPlugins`, a mod installed earlier is invisible to modwall. `/modwall scan` still reports it.
* **Judge organization or built-in mods.** Mods in the `prepend` and `append` tiers and those built into Claude Code are recorded as `not-judged` and always pass.
* **Judge behavior.** It reads what the scanner found in the source, not what the code does at run time. A mod that calls `$.process.run` once to start a helper program has handed everything to that program, and modwall only knows "processes". Treat `processes` and `network` as "can do anything".
* **See classic plugins.** Command hooks in `hooks/hooks.json`, MCP servers, skills and agents are not hooks modules and never fire `plugin.register`. `scan` lists them; it cannot refuse them.
* **Survive `--safe-mode` or a crashed hooks worker.** In both cases installed mods do not run, modwall included (and so do the mods it would judge).
* **Stop a determined local attacker.** Anyone who can edit your settings or modwall's store file can remove it or allowlist anything. It protects against mods you install carelessly, not against someone who already controls your account.
* **Trust names.** `name`, `version` and `provenance` are the mod's own word. A blocklist entry keyed on a name is walked past by a rename; the allowlist is keyed on provenance and version for that reason, and `allowlist` mode is the strict option.

## Security model

modwall keeps its own reach small. `claude plugin validate .` reports exactly this:

* Hooks: `plugin.register`, `session.start`, and `command.run` for its own `/modwall` command only.
* No prompt reading, no transcript access, no tool-call hooks, no system prompt hooks, no `$.http` (no network), no `$.env` reads.
* `$.store` for its lists and log, `$.state` for the session's table, `$.clock.now` for timestamps, `$.ui.toast` for alerts.
* `$.process.run` only inside `/modwall scan`, which you run by hand, with fixed argv: `claude plugin list --json` and `claude plugin validate --json <folder>`.

By its own rules modwall rates itself high risk (`other-mods`, `processes`), because a mod that can refuse other mods is a powerful thing to install. Read `hooks/register.tsx` and `hooks/classify.ts` before you trust it; together they are about 400 lines.

## Tests

```
claude plugin validate .
claude plugin test .
```

`claude plugin test` runs 21 tests in `hooks/*.test.tsx`: reach and risk classification, the policy decision in each mode, refusal in `allowlist` and `ask` mode, the blocklist, the `/modwall` table, log and list commands, `scan` against stubbed `claude` output, judging from the `prepend` tier, and fail closed when the check throws.

Type check with a `tsconfig.json` kept outside the repo, using the declaration file Claude Code writes beside a loaded mod (`.claude-plugin/types/claude-code/index.d.ts`) or the one in the plugin-authoring skill:

```json
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment", "types": []
  },
  "files": ["/path/to/claude-code.d.ts"],
  "include": ["/path/to/modwall/hooks/**/*", "/path/to/modwall/types/**/*"]
}
```

```
npx -y -p typescript@5.6.3 tsc -p /path/to/tsconfig.json
```

Requires Claude Code 2.1.287 or newer. Tested on 2.1.293.

## Built by RadTech

[RadTech](https://radtech.nl) builds apps, web products and applied AI, and advises founders. We do AI advisory, building and consulting.

Hire us: https://cal.com/radtech-solutions-yjxizt/15min

## License

MIT, see [LICENSE](LICENSE).
