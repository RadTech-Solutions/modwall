import { update } from 'claude-code'
import type { EngineInterface, PluginRegisterInput, Register } from 'claude-code'

import type { ModwallAllow, ModwallLogEntry, ModwallMode, ModwallSeen } from '../types'
import { decide, pad, reachOf, riskOf, usesFromNotes, versionOf } from './classify'

// modwall keeps its own reach small on purpose: it reads no prompt, gates no
// tool call and makes no network request. It judges other mods as they load,
// keeps its lists in $.store, and runs a host command only for /modwall scan.

const seenRef = { plugin: 'modwall', key: 'seen' } as const
const startedRef = { plugin: 'modwall', key: 'isStarted' } as const

const LOG_CAP = 500
const MODES: readonly ModwallMode[] = ['audit', 'ask', 'allowlist']

function modeOf(options: Readonly<Record<string, unknown>>): ModwallMode {
  const m = options.mode
  return MODES.includes(m as ModwallMode) ? (m as ModwallMode) : 'audit'
}

async function readArray<T>($: EngineInterface, key: string): Promise<T[]> {
  const v = await $.store.get(key)
  return Array.isArray(v) ? (v as T[]) : []
}

async function readSeen($: EngineInterface): Promise<ModwallSeen[]> {
  const { value } = await $.state.get(seenRef)
  return value ?? []
}

async function judge($: EngineInterface, e: PluginRegisterInput, mode: ModwallMode) {
  const reach = reachOf(e.uses)
  const risk = riskOf(reach)
  const allow = await readArray<ModwallAllow>($, 'allow')
  const block = await readArray<string>($, 'block')
  const known = await readArray<string>($, 'known')
  const id = `${e.provenance}#${versionOf(e)}`
  const verdict = decide(mode, e, risk, allow, block, known.includes(id))
  const at = await $.clock.now()

  const { value: isStarted = false } = await $.state.get(startedRef)
  const row: ModwallSeen = {
    name: e.name,
    provenance: e.provenance,
    version: versionOf(e),
    tier: e.tier,
    root: e.root,
    reach,
    risk,
    status: verdict.status,
    reason: verdict.reason,
    isNotified: !verdict.shouldNotify,
    at,
  }
  if (verdict.shouldNotify && isStarted) {
    $.ui.toast(toastText(row), { timeoutMs: 10000 })
    row.isNotified = true
  }
  await update($, seenRef, prev => [...(prev ?? []).filter(s => s.provenance !== e.provenance), row])

  if (e.tier === 'user') {
    if (!known.includes(id)) await $.store.set('known', [...known, id].slice(-2000))
    const log = await readArray<ModwallLogEntry>($, 'log')
    const entry: ModwallLogEntry = {
      at,
      name: e.name,
      provenance: e.provenance,
      version: row.version,
      risk,
      status: verdict.status,
      reason: verdict.reason,
    }
    await $.store.set('log', [...log, entry].slice(-LOG_CAP))
  }
  return verdict
}

function toastText(s: ModwallSeen): string {
  const what = s.reach.length ? s.reach.join(', ') : 'nothing notable'
  if (s.status === 'flagged') return `modwall: new high-risk mod ${s.name} (${what}). /modwall to review`
  return `modwall: ${s.status} ${s.name} (${s.risk}: ${what})`
}

async function flushToasts($: EngineInterface) {
  const seen = await readSeen($)
  const pending = seen.filter(s => !s.isNotified)
  for (const s of pending) $.ui.toast(toastText(s), { timeoutMs: 10000 })
  if (pending.length) await update($, seenRef, prev => (prev ?? []).map(s => ({ ...s, isNotified: true })))
}

function table(seen: readonly ModwallSeen[], mode: ModwallMode): string {
  if (seen.length === 0) {
    return [
      `modwall (${mode} mode): no other mod loaded after modwall this session.`,
      'modwall only sees mods that load after it. See the README on load order, or run /modwall scan.',
    ].join('\n')
  }
  const head = `${pad('MOD', 22)} ${pad('VERSION', 12)} ${pad('RISK', 6)} ${pad('DECISION', 16)} REACH`
  const rows = seen.map(
    s =>
      `${pad(s.name, 22)} ${pad(s.version, 12)} ${pad(s.risk, 6)} ${pad(s.status, 16)} ${s.reach.join(', ') || '-'}`,
  )
  return [`modwall (${mode} mode), ${seen.length} mod(s) seen this session:`, head, ...rows].join('\n')
}

function logText(log: readonly ModwallLogEntry[]): string {
  if (log.length === 0) return 'modwall log is empty.'
  const rows = log
    .slice(-30)
    .map(l => `${new Date(l.at).toISOString()}  ${pad(l.name, 22)} ${pad(l.version, 12)} ${pad(l.risk, 6)} ${pad(l.status, 16)} ${l.reason}`)
  return [`modwall log, last ${rows.length} of ${log.length}:`, ...rows].join('\n')
}

/** Finds the provenance and version for a name the person typed. */
function resolveTarget(seen: readonly ModwallSeen[], arg: string): { provenance: string; version: string } | undefined {
  const [who = '', ver] = arg.split(/\s+/)
  const hit = seen.find(s => s.name === who || s.provenance === who)
  if (hit) return { provenance: hit.provenance, version: ver ?? hit.version }
  if (who.includes('@')) return { provenance: who, version: ver ?? '*' }
  return undefined
}

async function allowCmd($: EngineInterface, arg: string): Promise<string> {
  const target = resolveTarget(await readSeen($), arg)
  if (!target) return `modwall: no mod named "${arg}" was seen this session. Give its id instead, as name@marketplace [version].`
  const at = await $.clock.now()
  const allow = (await readArray<ModwallAllow>($, 'allow')).filter(
    a => !(a.provenance === target.provenance && a.version === target.version),
  )
  await $.store.set('allow', [...allow, { ...target, at }])
  const block = await readArray<string>($, 'block')
  const name = target.provenance.split('@')[0] ?? target.provenance
  await $.store.set('block', block.filter(b => b !== target.provenance && b !== name))
  return `modwall: allowed ${target.provenance} at version ${target.version}. Run /reload-plugins to load it if it was held.`
}

async function blockCmd($: EngineInterface, arg: string): Promise<string> {
  const target = resolveTarget(await readSeen($), arg)
  const key = target?.provenance ?? arg.split(/\s+/)[0] ?? ''
  if (!key) return 'modwall: say which mod, as /modwall block <name>.'
  const block = await readArray<string>($, 'block')
  if (!block.includes(key)) await $.store.set('block', [...block, key])
  const allow = await readArray<ModwallAllow>($, 'allow')
  await $.store.set('allow', allow.filter(a => a.provenance !== key))
  return `modwall: blocked ${key}. It is refused from the next load on; run /reload-plugins to drop it now.`
}

async function unblockCmd($: EngineInterface, arg: string): Promise<string> {
  const key = arg.split(/\s+/)[0] ?? ''
  const target = resolveTarget(await readSeen($), key)
  const block = await readArray<string>($, 'block')
  const kept = block.filter(b => b !== key && b !== target?.provenance)
  await $.store.set('block', kept)
  return kept.length === block.length ? `modwall: ${key} was not blocked.` : `modwall: unblocked ${key}.`
}

async function listsText($: EngineInterface): Promise<string> {
  const allow = await readArray<ModwallAllow>($, 'allow')
  const block = await readArray<string>($, 'block')
  return [
    `allowlist (${allow.length}): ${allow.map(a => `${a.provenance} ${a.version}`).join('; ') || 'empty'}`,
    `blocklist (${block.length}): ${block.join('; ') || 'empty'}`,
  ].join('\n')
}

type Listed = { id: string; version?: string; enabled?: boolean; installPath?: string; readFromFolder?: string; mcpServers?: Record<string, unknown> }
type Validated = { contents?: { type?: string; notes?: string[] }[] }

async function scan($: EngineInterface): Promise<string> {
  const listed = await $.process.run(['claude', 'plugin', 'list', '--json'], { timeoutMs: 30000 }).catch(() => undefined)
  if (!listed || listed.exitCode !== 0) return 'modwall scan: could not run `claude plugin list --json`.'
  let plugins: Listed[]
  try {
    plugins = JSON.parse(listed.stdout) as Listed[]
  } catch {
    return 'modwall scan: `claude plugin list --json` did not return JSON.'
  }
  const lines = [`modwall scan: ${plugins.length} installed plugin(s)`]
  lines.push(`${pad('PLUGIN', 40)} ${pad('ON', 3)} ${pad('RISK', 6)} FOOTPRINT`)
  for (const p of plugins) {
    const root = p.readFromFolder ?? p.installPath
    const mcp = Object.keys(p.mcpServers ?? {})
    let risk = '-'
    const foot: string[] = []
    if (root) {
      const out = await $.process
        .run(['claude', 'plugin', 'validate', '--json', root], { timeoutMs: 30000 })
        .catch(() => undefined)
      let report: Validated | undefined
      try {
        report = out ? (JSON.parse(out.stdout) as Validated) : undefined
      } catch {
        report = undefined
      }
      const hooks = (report?.contents ?? []).filter(c => c.type === 'hooks')
      const notes = hooks.flatMap(c => c.notes ?? [])
      const uses = usesFromNotes(notes)
      if (uses.events.length || uses.calls.length) {
        const reach = reachOf(uses)
        risk = riskOf(reach)
        foot.push(`mod: ${reach.join(', ') || 'ui only'}`)
      } else if (hooks.length) {
        foot.push('command hooks (run as shell commands, not judged by plugin.register)')
      }
      if (!report) foot.push('validate failed')
    }
    if (mcp.length) foot.push(`MCP: ${mcp.join(', ')}`)
    lines.push(`${pad(p.id, 40)} ${pad(p.enabled === false ? 'no' : 'yes', 3)} ${pad(risk, 6)} ${foot.join('; ') || 'skills/commands only'}`)
  }
  return lines.join('\n')
}

const HELP = [
  '/modwall              mods seen this session: reach, risk, decision',
  '/modwall allow <name> [version|*]   allow a mod (by name seen this session, or name@marketplace)',
  '/modwall block <name>               refuse a mod at every load',
  '/modwall unblock <name>',
  '/modwall lists        show the allowlist and blocklist',
  '/modwall log          the persistent decision log',
  '/modwall scan         validate every installed plugin and report its footprint',
].join('\n')

export const register: Register = (on, options) => {
  const mode = modeOf(options)

  on('plugin.register', async ($, e, next) => {
    const verdict = await judge($, e, mode)
    if (verdict.isRefused) return { refuse: verdict.reason }
    return next(e)
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    if (e.tier === 'user' && mode !== 'audit') return { refuse: 'modwall could not check this mod, so it was not loaded' }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'modwall',
      description: 'Firewall for mods: what each loaded mod can reach, and allow/block/log/scan',
      argumentHint: '[allow|block|unblock|lists|log|scan] [name]',
    })
    await $.state.set(startedRef, true)
    await flushToasts($)
    return next(e)
  })

  on('command.run', { command: 'modwall' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    if (verb === '') return { text: table(await readSeen($), mode) }
    if (verb === 'allow' && arg) return { text: await allowCmd($, arg) }
    if (verb === 'block' && arg) return { text: await blockCmd($, arg) }
    if (verb === 'unblock' && arg) return { text: await unblockCmd($, arg) }
    if (verb === 'lists') return { text: await listsText($) }
    if (verb === 'log') return { text: logText(await readArray<ModwallLogEntry>($, 'log')) }
    if (verb === 'scan') return { text: await scan($) }
    return { text: HELP }
  })
}
