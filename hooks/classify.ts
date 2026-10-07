// Pure functions: read a mod's scanned `uses`, name its reach, rate its risk,
// and decide what the policy does with it. Nothing here touches `$`.

import type {
  ModwallAllow,
  ModwallMode,
  ModwallReach,
  ModwallRisk,
  ModwallStatus,
} from '../types'

export type Uses = {
  events: readonly string[]
  calls: readonly string[]
  env?: { reads: readonly string[]; writes: readonly string[] }
}

const PROMPT_EVENTS = [
  'prompt.submit',
  'prompt.mention',
  'session.append',
  'turn.step',
  'model.complete',
  'classic.UserPromptSubmit',
]
const PROMPT_CALLS = ['session.messages', 'model.fork']
const GATE_EVENTS = ['tool.call', 'tool.check', 'classic.PreToolUse', 'classic.PermissionRequest']
const SYSTEM_PROMPT_EVENTS = ['prompt.section', 'prompt.compose', 'prompt.context', 'skill.prompt']
const OTHER_MOD_EVENTS = ['plugin.register', 'engine.create']
const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|AUTH|CRED|COOKIE|SESSION/i

/** Whether one `on(...)` pattern, as written, would receive `event`. */
export function patternHits(pattern: string, event: string): boolean {
  if (pattern.startsWith('!')) return pattern.slice(1) !== event
  if (pattern === '*') return !event.startsWith('telemetry.')
  if (pattern.endsWith('.*')) return event.startsWith(pattern.slice(0, -1))
  return pattern === event
}

function hooksAny(events: readonly string[], targets: readonly string[]): boolean {
  return events.some(p => targets.some(t => patternHits(p, t)))
}

function callsAny(calls: readonly string[], prefixes: readonly string[]): boolean {
  return calls.some(c => prefixes.some(p => (p.endsWith('.') ? c.startsWith(p) : c === p)))
}

/** The reach a mod has, in a fixed order, each once. */
export function reachOf(uses: Uses): ModwallReach[] {
  const { events, calls } = uses
  const envReads = uses.env?.reads ?? []
  const reach: ModwallReach[] = []
  if (hooksAny(events, PROMPT_EVENTS) || callsAny(calls, PROMPT_CALLS)) reach.push('prompts')
  if (callsAny(calls, ['http.'])) reach.push('network')
  if (callsAny(calls, ['process.'])) reach.push('processes')
  if (envReads.length > 0 || callsAny(calls, ['env.get', 'env.set'])) reach.push('env')
  if (envReads.some(n => SECRET_NAME.test(n))) reach.push('secrets')
  if (hooksAny(events, GATE_EVENTS)) reach.push('tool-gate')
  if (hooksAny(events, SYSTEM_PROMPT_EVENTS)) reach.push('system-prompt')
  if (callsAny(calls, ['fs.write'])) reach.push('file-write')
  if (callsAny(calls, ['fs.read', 'fs.list', 'fs.ancestors'])) reach.push('file-read')
  if (hooksAny(events, OTHER_MOD_EVENTS)) reach.push('other-mods')
  if (events.some(p => p.startsWith('telemetry.'))) reach.push('telemetry')
  return reach
}

const HIGH: readonly ModwallReach[] = [
  'network',
  'processes',
  'secrets',
  'tool-gate',
  'system-prompt',
  'other-mods',
]
const MEDIUM: readonly ModwallReach[] = ['prompts', 'env', 'file-write', 'file-read', 'telemetry']

export function riskOf(reach: readonly ModwallReach[]): ModwallRisk {
  if (reach.some(r => HIGH.includes(r))) return 'high'
  if (reach.some(r => MEDIUM.includes(r))) return 'medium'
  return 'low'
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
 */
export function decide(
  mode: ModwallMode,
  mod: Mod,
  risk: ModwallRisk,
  allow: readonly ModwallAllow[],
  block: readonly string[],
  isKnown: boolean,
): Verdict {
  if (mod.tier !== 'user') {
    return { isRefused: false, status: 'not-judged', reason: `tier ${mod.tier} is outside modwall's reach`, shouldNotify: false }
  }
  if (isBlocked(mod, block)) {
    return { isRefused: true, status: 'blocked', reason: `modwall: ${mod.name} is on your blocklist`, shouldNotify: true }
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

/** Reads `uses` back out of `claude plugin validate --json` notes. */
export function usesFromNotes(notes: readonly string[]): Uses {
  const events: string[] = []
  const calls: string[] = []
  const reads: string[] = []
  const split = (s: string) =>
    s.trim() === 'nothing' ? [] : s.split(',').map(x => x.trim().replace(/^\$\./, '')).filter(Boolean)
  for (const note of notes) {
    const m = /^\S+ (hooks|calls|env reads): (.*)$/.exec(note)
    if (!m) continue
    const [, kind, list] = m
    const items = split(list ?? '')
    if (kind === 'hooks') events.push(...items)
    else if (kind === 'calls') calls.push(...items)
    else reads.push(...items)
  }
  return { events, calls, env: reads.length ? { reads, writes: [] } : undefined }
}

export function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
}
