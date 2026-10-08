// Pure functions: read a mod's scanned `uses`, name its reach, rate its risk,
// and decide what the policy does with it. Nothing here touches `$`.
//
// The classifier is an allowlist. Only a small known-safe set of events and
// calls is low risk; anything else, including anything this file does not
// know, is high.

import type {
  ModwallAllow,
  ModwallMode,
  ModwallReach,
  ModwallRisk,
  ModwallSeen,
  ModwallStatus,
} from '../types'

export type Uses = {
  events: readonly string[]
  calls: readonly string[]
  env?: { reads: readonly string[]; writes: readonly string[] }
  state?: { reads: readonly { plugin: string }[]; writes: readonly { plugin: string }[] }
}

// Events a mod may hook and stay low risk. `command.run(own)` and
// `ui.render(pane)` are not event names: /modwall scan writes them when the
// validator shows the hook is matched to the mod's own command, or to the
// AbovePrompt band or a Pane. At load the matcher is not visible, so a bare
// `command.run` or `ui.render` is high.
const SAFE_EVENTS = ['session.start', 'session.end', 'turn.start', 'command.run(own)', 'ui.render(pane)']

const SAFE_CALLS = [
  'ui.notice',
  'ui.invalidate',
  'ui.blit',
  'ui.resolve',
  'ui.log',
  'ui.toast',
  'ui.status',
  'ui.open',
  'ui.close',
  'ui.panes',
  'ui.scroll',
  'ui.focus',
  'store.get',
  'store.set',
  'store.delete',
  'store.keys',
  'state.get',
  'state.set',
  'command.register',
  // read-only session facts: the folder, the model, the surface, the version
  'session.cwd',
  'session.root',
  'session.model',
  'session.turns',
  'session.id',
  'session.surfaces',
  'session.surface',
  'session.version',
]

const EVENT_GROUPS: readonly [ModwallReach, readonly string[]][] = [
  [
    'prompts',
    [
      'prompt.submit',
      'prompt.mention',
      'prompt.fill',
      'prompt.edit',
      'prompt.attachment',
      'session.append',
      'session.send',
      'session.receive',
      'session.compact',
      'turn.step',
      'turn.complete',
      'model.complete',
      'model.fork',
      'classic.UserPromptSubmit',
    ],
  ],
  ['tool-gate', ['tool.call', 'tool.check', 'tool.describe', 'tool.list', 'tool.register', 'classic.PreToolUse', 'classic.PostToolUse', 'classic.PermissionRequest']],
  ['system-prompt', ['prompt.section', 'prompt.compose', 'prompt.context', 'skill.prompt']],
  ['other-mods', ['plugin.register', 'engine.create', 'state.get', 'state.set']],
  ['agents', ['agent.spawn', 'agent.offer']],
  ['config', ['config.set', 'config.describe', 'settings.read']],
  ['commands', ['command.run', 'command.describe']],
  ['screen', ['ui.render', 'ui.input', 'ui.press', 'ui.select', 'ui.copy', 'ui.focus']],
]

// A hook on a `$` call's name sees, and can rewrite or refuse, that call for
// every other mod (and for modwall's own store reads).
const API_NOUNS = ['fs.', 'http.', 'process.', 'store.', 'env.', 'clock.', 'mcp.', 'audio.', 'command.register', 'ui.']

const CALL_GROUPS: readonly [ModwallReach, readonly string[]][] = [
  ['network', ['http.']],
  ['processes', ['process.']],
  ['file-read', ['fs.read', 'fs.list', 'fs.stat', 'fs.exists', 'fs.ancestors']],
  ['file-write', ['fs.write']],
  ['tool-calls', ['tool.', 'mcp.']],
  ['prompts', ['session.messages', 'session.append', 'model.', 'prompt.']],
  ['agents', ['agent.']],
  ['commands', ['command.run', 'command.list']],
  ['screen', ['ui.ask', 'ui.copy', 'ui.selection']],
]

const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|AUTH|CRED|COOKIE|SESSION/i

/** Whether one `on(...)` pattern, as written, would receive `event`. */
export function patternHits(pattern: string, event: string): boolean {
  if (pattern.startsWith('!')) return pattern.slice(1) !== event
  if (pattern === '*') return !event.startsWith('telemetry.')
  if (pattern.endsWith('.*')) return event.startsWith(pattern.slice(0, -1))
  return pattern === event
}

function isWildcard(p: string): boolean {
  return p === '*' || p.startsWith('!') || p.endsWith('.*')
}

function startsAny(s: string, prefixes: readonly string[]): boolean {
  return prefixes.some(p => (p.endsWith('.') ? s.startsWith(p) : s === p))
}

/** The reach a mod has, each label once, in the order found. */
export function reachOf(uses: Uses, name?: string): ModwallReach[] {
  const reach = new Set<ModwallReach>()

  for (const p of uses.events) {
    if (SAFE_EVENTS.includes(p)) continue
    if (p.startsWith('telemetry.')) {
      reach.add('telemetry')
      continue
    }
    if (isWildcard(p)) {
      reach.add('wildcard')
      for (const [label, events] of EVENT_GROUPS) if (events.some(ev => patternHits(p, ev))) reach.add(label)
      continue
    }
    const group = EVENT_GROUPS.find(([, events]) => events.includes(p))
    if (group) reach.add(group[0])
    else if (startsAny(p, API_NOUNS)) reach.add('intercepts-api')
    else reach.add('unknown')
  }

  for (const c of uses.calls) {
    if (SAFE_CALLS.includes(c) || c.startsWith('clock.')) continue
    if (c === 'env.get') continue // judged from env.reads below
    if (c === 'env.set') {
      reach.add('env-write')
      continue
    }
    const group = CALL_GROUPS.find(([, prefixes]) => startsAny(c, prefixes))
    reach.add(group ? group[0] : 'unknown')
  }

  const envReads = uses.env?.reads ?? []
  if (envReads.some(n => SECRET_NAME.test(n))) reach.add('secret-names')
  else if (envReads.length > 0 || uses.calls.includes('env.get')) reach.add('env')

  if (name !== undefined) {
    const refs = [...(uses.state?.reads ?? []), ...(uses.state?.writes ?? [])]
    if (refs.some(r => r.plugin !== name)) reach.add('other-mods')
  }
  return [...reach]
}

/** Low: only known-safe uses. Medium: reads env vars whose names do not look secret. High: anything else. */
export function riskOf(reach: readonly ModwallReach[]): ModwallRisk {
  if (reach.length === 0) return 'low'
  if (reach.every(r => r === 'env')) return 'medium'
  return 'high'
}

export type Mod = { name: string; provenance: string; version?: string; tier: string }

export type Verdict = { isRefused: boolean; status: ModwallStatus; reason: string; shouldNotify: boolean }

export function versionOf(mod: { version?: string }): string {
  return mod.version ?? 'unversioned'
}

export function isAllowlisted(mod: Mod, allow: readonly ModwallAllow[]): boolean {
  const v = versionOf(mod)
  return allow.some(a => a.provenance === mod.provenance && (a.version === '*' || a.version === v))
}

export function isBlocked(mod: Mod, block: readonly string[]): boolean {
  return block.includes(mod.provenance) || block.includes(mod.name)
}

/**
 * What the policy does with one mod. Only the `user` tier is judged: the
 * mods an organization lists and the ones built into the binary pass.
 * `isListBroken` says a stored list was present but unreadable: then
 * ask and allowlist refuse, and audit allows but says so.
 */
export function decide(
  mode: ModwallMode,
  mod: Mod,
  risk: ModwallRisk,
  allow: readonly ModwallAllow[],
  block: readonly string[],
  isKnown: boolean,
  isListBroken = false,
): Verdict {
  if (mod.tier !== 'user') {
    return { isRefused: false, status: 'not-judged', reason: `tier ${mod.tier} is outside modwall's reach`, shouldNotify: false }
  }
  if (isBlocked(mod, block)) {
    return { isRefused: true, status: 'blocked', reason: `modwall: ${mod.name} is on your blocklist`, shouldNotify: true }
  }
  if (isListBroken) {
    if (mode !== 'audit') {
      return {
        isRefused: true,
        status: 'check-failed',
        reason: `modwall: its stored lists are damaged, so ${mod.name} was not loaded (/modwall lists)`,
        shouldNotify: true,
      }
    }
    return { isRefused: false, status: 'check-failed', reason: 'stored lists are damaged; allowed in audit mode', shouldNotify: true }
  }
  const isAllowed = isAllowlisted(mod, allow)
  if (mode === 'allowlist' && !isAllowed) {
    return {
      isRefused: true,
      status: 'not-allowlisted',
      reason: `modwall: ${mod.provenance} ${versionOf(mod)} is not on the allowlist (/modwall allow ${mod.name}, then /reload-plugins)`,
      shouldNotify: true,
    }
  }
  if (mode === 'ask' && risk === 'high' && !isAllowed) {
    return {
      isRefused: true,
      status: 'held',
      reason: `modwall: high-risk mod ${mod.provenance} ${versionOf(mod)} is held until you approve it (/modwall allow ${mod.name}, then /reload-plugins)`,
      shouldNotify: true,
    }
  }
  if (risk === 'high' && !isAllowed) {
    return { isRefused: false, status: 'flagged', reason: 'high risk, allowed in audit mode', shouldNotify: !isKnown }
  }
  return { isRefused: false, status: 'allowed', reason: isAllowed ? 'on the allowlist' : `${risk} risk`, shouldNotify: false }
}

/** Splits a validator list on top-level commas, keeping `{...}` matchers whole. */
function splitTop(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of list) {
    if (ch === '{') depth++
    if (ch === '}') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out.filter(s => s !== 'nothing')
}

function stripMatcher(s: string): string {
  const i = s.indexOf('{')
  return (i < 0 ? s : s.slice(0, i)).trim()
}

const PANE_MATCHER = /^ui\.render\{component=(AbovePrompt|Pane)\}$/

export type ValidateReport = {
  contents?: { type?: string; notes?: readonly string[]; gatingHooks?: readonly { hook?: string; pattern?: string }[] }[]
}

/**
 * Reads `uses` back out of a `claude plugin validate --json` report: the
 * hooks, calls and env reads in its notes, plus every gating hook from the
 * structured `gatingHooks` field. A `command.run` hook the validator says
 * answers the mod's own command becomes `command.run(own)`, and a
 * `ui.render` matched to AbovePrompt or Pane becomes `ui.render(pane)`.
 */
export function usesFromReport(report: ValidateReport): Uses {
  const hooks = (report.contents ?? []).filter(c => c.type === 'hooks')
  const notes = hooks.flatMap(c => c.notes ?? [])
  const own = new Set<string>()
  for (const note of notes) {
    const m = /^\S+ answers its own command: (.*)$/.exec(note)
    if (m) for (const item of splitTop(m[1] ?? '')) own.add(item)
  }
  const events: string[] = []
  const calls: string[] = []
  const reads: string[] = []
  const stateReads: { plugin: string }[] = []
  const stateWrites: { plugin: string }[] = []
  for (const note of notes) {
    const m = /^\S+ (hooks|calls|env reads|state reads|state writes): (.*)$/.exec(note)
    if (!m) continue
    const kind = m[1]
    const list = (m[2] ?? '').replace(/\s\(via [^)]*\)/g, '')
    for (const item of splitTop(list)) {
      if (kind === 'hooks') {
        if (own.has(item)) events.push('command.run(own)')
        else if (PANE_MATCHER.test(item)) events.push('ui.render(pane)')
        else events.push(stripMatcher(item))
      } else if (kind === 'calls') calls.push(item.replace(/^\$\./, ''))
      else if (kind === 'env reads') reads.push(item)
      else (kind === 'state reads' ? stateReads : stateWrites).push({ plugin: item.split('.')[0] ?? item })
    }
  }
  for (const g of hooks.flatMap(c => c.gatingHooks ?? [])) {
    const ev = stripMatcher(g.pattern ?? g.hook ?? '')
    if (ev && !events.includes(ev)) events.push(ev)
  }
  return {
    events: [...new Set(events)],
    calls: [...new Set(calls)],
    env: reads.length ? { reads, writes: [] } : undefined,
    state: stateReads.length || stateWrites.length ? { reads: stateReads, writes: stateWrites } : undefined,
  }
}

export type Target = { provenance: string; version: string; isAnyVersion: boolean }

/** Finds the provenance and version for what the person typed, or says why it cannot. */
export function resolveTarget(seen: readonly Pick<ModwallSeen, 'name' | 'provenance' | 'version'>[], arg: string): Target | string {
  const [who = '', ver] = arg.split(/\s+/)
  const byProvenance = seen.find(s => s.provenance === who)
  if (byProvenance) return { provenance: byProvenance.provenance, version: ver ?? byProvenance.version, isAnyVersion: ver === '*' }
  const byName = seen.filter(s => s.name === who)
  if (byName.length > 1) {
    return `modwall: more than one mod named "${who}" was seen (${byName.map(s => s.provenance).join(', ')}). Give the one you mean as name@marketplace.`
  }
  const hit = byName[0]
  if (hit) return { provenance: hit.provenance, version: ver ?? hit.version, isAnyVersion: ver === '*' }
  if (who.includes('@')) return { provenance: who, version: ver ?? '*', isAnyVersion: (ver ?? '*') === '*' }
  return `modwall: no mod named "${who}" was seen this session. Give its id instead, as name@marketplace [version].`
}

export function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
}
