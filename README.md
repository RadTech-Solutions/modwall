# modwall

A firewall for Claude Code mods: see what each mod's code can reach as it loads, and audit, hold or refuse it by your own policy.

## Overview

A mod is a plugin that runs code inside Claude Code with your permissions. It can read every prompt, approve or rewrite tool calls, change the system prompt, start processes and reach the network. Nothing on screen tells you which of those a mod you just installed does.

modwall hooks the `plugin.register` event, which fires each time another mod's hooks module is about to load. That event carries what Claude Code's own scanner read from the mod's source: the event names it hooks, the `$` calls it makes, the environment variables it names and the `$.state` values it refers to. The scan is exact for those four lists: the type declarations for `PluginRegisterUses` say "a module that spells `on`, `$`, `$.env` or a `$.state` reference other than literally does not load". Building a call name at run time is not a way around it; such a module never loads.

modwall turns those lists into reach labels and a risk level. The classifier is an allowlist: only a small known-safe set is low risk, and anything else, including anything modwall does not recognise, is high.

**Low** (known safe, nothing else used):

* events `session.start`, `session.end`, `turn.start`
* calls `ui.toast`, `ui.status`, `ui.log`, `ui.notice`, `ui.resolve`, `ui.invalidate`, `ui.blit`, `ui.open`, `ui.close`, `ui.panes`, `ui.scroll`, `ui.focus`, every `clock.*`, `store.get`/`set`/`delete`/`keys` (a mod's store is its own), `state.get`/`set` on the mod's own values, `command.register`, and the read-only session facts `session.cwd`, `root`, `model`, `turns`, `id`, `surface`, `surfaces` and `version`
* in `/modwall scan` only: a `command.run` hook the validator reports as answering the mod's own command, and a `ui.render` hook matched to the `AbovePrompt` band or a `Pane`

**Medium**: reads environment variables, and none of their names looks like a secret.

**High**: everything else. The labels say why:

| Label | Examples |
|---|---|
| `prompts` | hooks `prompt.submit`, `prompt.fill`, `prompt.edit`, `prompt.attachment`, `session.append`, `session.send`, `session.receive`, `session.compact`, `turn.step`, `turn.complete`, `model.complete`; calls `session.messages`, `session.append`, `model.*`, `prompt.*` |
| `tool-gate` | hooks `tool.call`, `tool.check`, `tool.describe`, `classic.PreToolUse`, `classic.PermissionRequest` (can approve, refuse or rewrite tool calls) |
| `tool-calls` | calls `tool.*`, `mcp.*` |
| `system-prompt` | hooks `prompt.section`, `prompt.compose`, `prompt.context`, `skill.prompt` |
| `network` | calls `http.*` |
| `processes` | calls `process.*` |
| `secret-names` | reads an environment variable whose name looks like a key, token, password or credential (modwall sees the name, not the value) |
| `env-write` | calls `env.set` |
| `file-read`, `file-write` | calls `fs.read`, `fs.list`, `fs.stat`, `fs.exists`, `fs.ancestors`; `fs.write` |
| `other-mods` | hooks `plugin.register`, `engine.create`, `state.get`, `state.set`; refers to another mod's `$.state` values |
| `intercepts-api` | hooks a `$` call by name (`store.get`, `store.set`, `http.fetch`, `process.run`, `fs.write`, `ui.toast` ...), which lets it see, rewrite or refuse that call for every other mod |
| `agents`, `config`, `commands`, `screen` | `agent.spawn`, `config.set`, a `command.run` hook, `ui.render` / `ui.input` / `ui.press`, `ui.copy`, `ui.selection`, `ui.ask` |
| `telemetry` | hooks `telemetry.*` |
| `wildcard` | hooks `*`, `prefix.*` or a `!negation`, listed with the groups it covers |
| `unknown` | any event or call not in the lists above |

At load, `plugin.register` gives the event names without their matchers (`command.run`, not `command.run{command=foo}`), so modwall cannot tell a mod's own command or status band from a hook on every command or every transcript row. Both count as high at load. `/modwall scan` reads the validator's report, which does show matchers, and can rate those mods lower.

Three policy modes:

* `audit` (default): every mod loads, except those on your blocklist. modwall records each one, logs it and toasts each high-risk mod the first time it sees it at that declared version.
* `ask`: high-risk mods that are not on your allowlist are refused at load and shown as `held`. Approve one with `/modwall allow <name>` and run `/reload-plugins`. Claude Code offers no dialog while mods load, so "ask" means hold first, approve after.
* `allowlist`: every user mod not on the allowlist is refused.

Allowlist entries are a provenance plus a version. Both are the mod's own word: `name` and `version` come from its own `plugin.json`, and `provenance` is that name plus where it was loaded from (`name@marketplace` when installed, `name@inline` for any `--plugin-dir` folder). So the version pin only means "the version string the mod declares". A mod can ship new code under the same version string, and any folder whose `plugin.json` says `"name": "foo"` loaded with `--plugin-dir` is `foo@inline`, matching an allowlist entry made for a different `foo` folder.

A blocklist applies in every mode. The allowlist, blocklist and a decision log (last 500 entries) are kept in modwall's `$.store`, so they survive across sessions.

## Set up

modwall can only judge mods that load after it. What we observed on Claude Code 2.1.293 (observed behaviour, not documented):

* `--plugin-dir` mods loaded in the order of the flags.
* Installed mods loaded in the order they were installed (in an isolated config: a mod installed before modwall was not judged, one installed after it was).
* In one run, a `--plugin-dir` modwall judged an installed mod, so `--plugin-dir` mods loaded ahead of installed ones there.

Two ways to put modwall ahead of other mods:

1. **`prependPlugins` in user settings.** In `~/.claude/settings.json`:

   ```json
   { "prependPlugins": ["modwall@modwall"] }
   ```

   In our isolated test (no managed settings, not signed in, modwall installed from a local directory marketplace) this loaded modwall in the `prepend` tier, and it judged every user mod whatever the install order. The docs say Claude Code reads `prependPlugins` from user settings only on a machine with no managed settings and when you are not signed in with a Team or Enterprise plan. We have not confirmed it for a signed-in account, or for a copy installed from GitHub.

   On a managed machine, `prependPlugins` in managed settings skips any plugin Claude Code copies from a GitHub, git, URL or npm source; those count as a user's mod. An administrator who wants modwall there has to vendor it into a directory marketplace on disk, listed with a relative `source`, as the admin docs describe.

2. **Install modwall before other mods**, or reinstall the other mods after it. This rests on the observed order above and is easy to undo by accident.

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

`/modwall allow <name>` for a mod seen this session pins its current declared version. `/modwall allow name@marketplace` with no version allows any version, and the reply says so. If two mods seen this session share a name, modwall asks for the `name@marketplace` form.

Example `/modwall` output:

```
modwall (audit mode), 2 mod(s) seen this session:
MOD                    VERSION      RISK   DECISION         REACH
spy                    6.6.6        high   flagged          prompts, tool-gate, network, processes, secret-names
dummy                  1.2.3        high   flagged          tool-gate, file-read, file-write
```

`/modwall scan` does not depend on load order. It runs `claude plugin list --json`, then `claude plugin validate --json <folder>` for each installed plugin whose folder is an absolute path, and prints each one's reach and risk, its MCP servers, and whether it carries command hooks. Use it to review what is installed, including mods that loaded before modwall.

Allowing or blocking takes effect at the next load. Run `/reload-plugins` to apply it now.

## What it can and cannot protect against

It can:

* Show you, at load, which mods hook prompts, gate tool calls, call the network, run processes, or name environment variables that look like secrets.
* Refuse a mod before any of its code runs: no hook, no command, no tool of it joins the session.
* Fail closed. In `ask` and `allowlist` mode, if modwall's check throws or times out, the user mod it was checking is refused. In `audit` mode the blocklist is still checked when the main check fails, as far as the store can be read. A stored list that is present but damaged (not a list of the right shape) makes `ask` and `allowlist` refuse every user mod, and is reported in `/modwall` and `/modwall lists`.

It cannot:

* **See mods that load before it.** `/modwall scan` still reports them.
* **Judge organization or built-in mods.** Mods in the `prepend` and `append` tiers and those built into Claude Code are recorded as `not-judged` and always pass.
* **Judge behaviour.** It reads which events and calls the scanner found in the source, not what the code does with them. A mod that runs a helper program with `$.process.run` has handed everything to that program. Treat `processes` and `network` as "can do anything".
* **Protect itself from a mod it admits.** A mod that hooks `store.get`, `store.set` or `process.run` by name sits in the same chain as modwall's own calls and can feed it a different allowlist, hide its log writes, or rewrite what `/modwall scan` reads. modwall flags such mods as `intercepts-api`, but once one is loaded, modwall's later decisions and reports cannot be trusted. Use `allowlist` mode, or `ask` mode, to keep them out.
* **Trust names or versions.** See the allowlist note above. A blocklist entry keyed on a name is walked past by a rename.
* **See classic plugins.** Command hooks in `hooks/hooks.json`, MCP servers, skills and agents are not hooks modules and never fire `plugin.register`. `scan` lists them; it cannot refuse them.
* **Survive `--safe-mode` or a crashed hooks worker.** In both cases installed mods do not run, modwall included (and so do the mods it would judge).
* **Stop someone who controls your account.** Anyone who can edit your settings or modwall's store file can remove modwall or allowlist anything.

## Security model

modwall keeps its own reach small. `claude plugin validate .` reports exactly this:

* Hooks: `plugin.register`, `session.start`, and `command.run` matched to its own `/modwall` command.
* Calls: `$.command.register` (to add `/modwall`), `$.store` for its lists and log, `$.state` for the session's table, `$.clock.now` for timestamps, `$.ui.toast` for alerts, and `$.process.run` only inside `/modwall scan`.
* No prompt or transcript access, no tool-call hooks, no system prompt hooks, no `$.http` (no network), no `$.env` reads, no hooks on other `$` calls.
* `/modwall scan` runs fixed argv only: `claude plugin list --json` and `claude plugin validate --json <folder>`, and skips any folder that is not an absolute path.

By its own rules modwall rates itself high risk (`other-mods`, `processes`), because a mod that can refuse other mods is a powerful thing to install. Read `hooks/register.tsx` and `hooks/classify.ts` before you trust it.

## Tests

```
claude plugin validate .
claude plugin test .
```

`claude plugin test` runs the tests in `hooks/*.test.tsx`: the allowlist classifier (safe set, every high group, hooks on `$` call names, wildcards, other mods' state), the policy decision in each mode, damaged stored lists, name resolution, parsing real `claude plugin validate --json` output, refusal in `allowlist` and `ask` mode, the blocklist, the `/modwall` table, log and list commands, `scan` against stubbed `claude` output, judging from the `prepend` tier, and fail closed when the check throws.

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
