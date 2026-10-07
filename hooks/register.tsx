import { update } from 'claude-code'
import type { EngineInterface, PluginRegisterInput, Register } from 'claude-code'

import type { ModwallAllow, ModwallLogEntry, ModwallMode, ModwallSeen } from '../types'
import { decide, isBlocked, pad, reachOf, resolveTarget, riskOf, usesFromReport, versionOf } from './classify'
import type { ValidateReport } from './classify'

// modwall keeps its own reach small on purpose: it reads no prompt, gates no
// tool call and makes no network request. It judges other mods as they load,
// keeps its lists in $.store, registers /modwall, and runs a host command
// only for /modwall scan.

const seenRef = { plugin: 'modwall', key: 'seen' } as const
const startedRef = { plugin: 'modwall', key: 'isStarted' } as const

const LOG_CAP = 500
const MODES: readonly ModwallMode[] = ['audit', 'ask', 'allowlist']

function modeOf(options: Readonly<Record<string, unknown>>): ModwallMode {
  const m = options.mode
  return MODES.includes(m as ModwallMode) ? (m as ModwallMode) : 'audit'
}

type Read<T> = { items: T[]; isBroken: boolean }

const isAllowEntry = (v: unknown): v is ModwallAllow =>
  typeof v === 'object' && v !== null && typeof (v as ModwallAllow).provenance === 'string' && typeof (v as ModwallAllow).version === 'string'
const isString = (v: unknown): v is string => typeof v === 'string'

/** A stored list: unset reads as empty; anything present that is not a list of the right shape is broken. */
async function readList<T>($: EngineInterface, key: string, isItem: (v: unknown) => v is T): Promise<Read<T>> {
  const v = await $.store.get(key)
  if (v === undefined) return { items: [], isBroken: false }
  if (!Array.isArray(v) || !v.every(isItem)) return { items: Array.isArray(v) ? v.filter(isItem) : [], isBroken: true }
  return { items: v, isBroken: false }
}

async function readSeen($: EngineInterface): Promise<ModwallSeen[]> {
  const { value } = await $.state.get(seenRef)
  return value ?? []
}

async function judge($: EngineInterface, e: PluginRegisterInput, mode: ModwallMode) {
  const reach = reachOf(e.uses, e.name)
  const risk = riskOf(reach)
  const allow = await readList($, 'allow', isAllowEntry)
  const block = await readList($, 'block', isString)
  const known = await readList($, 'known', isString)
  const id = `${e.provenance}#${versionOf(e)}`
  const verdict = decide(mode, e, risk, allow.items, block.items, known.items.includes(id), allow.isBroken || block.isBroken)

  // The verdict stands from here on; recording it must not change it.
  try {
    await record($, e, reach, risk, verdict, id, known)
  } catch {
    // A failed record leaves the verdict as decided.
  }
  return verdict
}

async function record(
  $: EngineInterface,
  e: PluginRegisterInput,
  reach: ModwallSeen['reach'],
  risk: ModwallSeen['risk'],
  verdict: ReturnType<typeof decide>,
  id: string,
  known: Read<string>,
) {
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

  if (e.tier !== 'user') return
  if (!known.isBroken && !known.items.includes(id)) await $.store.set('known', [...known.items, id].slice(-2000))
  const log = await $.store.get('log')
  if (log !== undefined && !Array.isArray(log)) return // damaged: leave it for the person to see
  const entry: ModwallLogEntry = { at, name: e.name, provenance: e.provenance, version: row.version, risk, status: verdict.status, reason: verdict.reason }
  await $.store.set('log', [...(log ?? []), entry].slice(-LOG_CAP))
}

function toastText(s: ModwallSeen): string {
  const what = s.reach.length ? s.reach.join(', ') : 'nothing notable'
  if (s.status === 'flagged') return `modwall: new high-risk mod ${s.name} (${what}). /modwall to review`
  if (s.status === 'check-failed') return `modwall: its stored lists are damaged (${s.name}: ${s.reason}). /modwall lists`
  return `modwall: ${s.status} ${s.name} (${s.risk}: ${what})`
}

async function flushToasts($: EngineInterface) {
  const seen = await readSeen($)
  const pending = seen.filter(s => !s.isNotified)
  for (const s of pending) $.ui.toast(toastText(s), { timeoutMs: 10000 })
  if (pending.length) await update($, seenRef, prev => (prev ?? []).map(s => ({ ...s, isNotified: true })))
}

async function brokenKeys($: EngineInterface): Promise<string[]> {
  const out: string[] = []
  if ((await readList($, 'allow', isAllowEntry)).isBroken) out.push('allow')
  if ((await readList($, 'block', isString)).isBroken) out.push('block')
  if ((await readList($, 'known', isString)).isBroken) out.push('known')
  const log = await $.store.get('log')
  if (log !== undefined && !Array.isArray(log)) out.push('log')
  return out
}

function brokenLine(keys: readonly string[]): string[] {
  if (keys.length === 0) return []
  return [
    `WARNING: stored ${keys.join(', ')} ${keys.length > 1 ? 'are' : 'is'} damaged (present but not a list of the right shape).`,
    'ask and allowlist mode refuse every user mod until this is fixed; audit mode cannot apply a damaged blocklist.',
  ]
}

function table(seen: readonly ModwallSeen[], mode: ModwallMode, broken: readonly string[]): string {
  if (seen.length === 0) {
    return [
      ...brokenLine(broken),
      `modwall (${mode} mode): no other mod loaded after modwall this session.`,
      'modwall only sees mods that load after it. See the README on load order, or run /modwall scan.',
    ].join('\n')
  }
  const head = `${pad('MOD', 22)} ${pad('VERSION', 12)} ${pad('RISK', 6)} ${pad('DECISION', 16)} REACH`
  const rows = seen.map(
    s => `${pad(s.name, 22)} ${pad(s.version, 12)} ${pad(s.risk, 6)} ${pad(s.status, 16)} ${s.reach.join(', ') || '-'}`,
  )
  return [...brokenLine(broken), `modwall (${mode} mode), ${seen.length} mod(s) seen this session:`, head, ...rows].join('\n')
}

function logText(log: unknown): string {
  if (log !== undefined && !Array.isArray(log)) return 'modwall: the stored log is damaged (not a list); nothing is appended to it until it is fixed.'
  if (!Array.isArray(log) || log.length === 0) return 'modwall log is empty.'
  const str = (v: unknown, fallback = '?') => (typeof v === 'string' ? v : fallback)
  const rows = log.slice(-30).map(raw => {
    if (typeof raw !== 'object' || raw === null) return '(unreadable entry)'
    const l = raw as Record<string, unknown>
    const at = typeof l.at === 'number' && Number.isFinite(l.at) ? new Date(l.at).toISOString() : '?'
    return `${at}  ${pad(str(l.name), 22)} ${pad(str(l.version), 12)} ${pad(str(l.risk), 6)} ${pad(str(l.status), 16)} ${str(l.reason, '')}`
  })
  return [`modwall log, last ${rows.length} of ${log.length}:`, ...rows].join('\n')
}

async function allowCmd($: EngineInterface, arg: string): Promise<string> {
  const target = resolveTarget(await readSeen($), arg)
  if (typeof target === 'string') return target
  const allowRead = await readList($, 'allow', isAllowEntry)
  const blockRead = await readList($, 'block', isString)
  if (allowRead.isBroken || blockRead.isBroken) return 'modwall: the stored lists are damaged; not changing them. See /modwall lists.'
  const at = await $.clock.now()
  const allow = allowRead.items.filter(a => !(a.provenance === target.provenance && a.version === target.version))
  await $.store.set('allow', [...allow, { provenance: target.provenance, version: target.version, at }])
  const name = target.provenance.split('@')[0] ?? target.provenance
  await $.store.set('block', blockRead.items.filter(b => b !== target.provenance && b !== name))
  const which = target.isAnyVersion ? 'at ANY version (*), including future updates' : `at version ${target.version} only`
  return `modwall: allowed ${target.provenance} ${which}. Run /reload-plugins to load it if it was held.`
}

async function blockCmd($: EngineInterface, arg: string): Promise<string> {
  const target = resolveTarget(await readSeen($), arg)
  const key = typeof target === 'string' ? (arg.split(/\s+/)[0] ?? '') : target.provenance
  if (!key) return 'modwall: say which mod, as /modwall block <name>.'
  const blockRead = await readList($, 'block', isString)
  const allowRead = await readList($, 'allow', isAllowEntry)
  if (allowRead.isBroken || blockRead.isBroken) return 'modwall: the stored lists are damaged; not changing them. See /modwall lists.'
  if (!blockRead.items.includes(key)) await $.store.set('block', [...blockRead.items, key])
  await $.store.set('allow', allowRead.items.filter(a => a.provenance !== key))
  return `modwall: blocked ${key}. It is refused from the next load on; run /reload-plugins to drop it now.`
}

async function unblockCmd($: EngineInterface, arg: string): Promise<string> {
  const key = arg.split(/\s+/)[0] ?? ''
  const target = resolveTarget(await readSeen($), key)
  const prov = typeof target === 'string' ? undefined : target.provenance
  const blockRead = await readList($, 'block', isString)
  if (blockRead.isBroken) return 'modwall: the stored blocklist is damaged; not changing it. See /modwall lists.'
  const kept = blockRead.items.filter(b => b !== key && b !== prov)
  await $.store.set('block', kept)
  return kept.length === blockRead.items.length ? `modwall: ${key} was not blocked.` : `modwall: unblocked ${key}.`
}

async function listsText($: EngineInterface): Promise<string> {
  const allow = await readList($, 'allow', isAllowEntry)
  const block = await readList($, 'block', isString)
  return [
    ...brokenLine(await brokenKeys($)),
    `allowlist (${allow.items.length}): ${allow.items.map(a => `${a.provenance} ${a.version}`).join('; ') || 'empty'}`,
    `blocklist (${block.items.length}): ${block.items.join('; ') || 'empty'}`,
  ].join('\n')
}

type Listed = { id: string; version?: string; enabled?: boolean; installPath?: string; readFromFolder?: string; mcpServers?: Record<string, unknown> }

/** A folder scan will hand to `claude plugin validate`: absolute, and never read as a flag. */
function isSafeRoot(root: string): boolean {
  return root.startsWith('/') && !root.startsWith('-') && !root.includes('\0')
}

async function scan($: EngineInterface): Promise<string> {
  const listed = await $.process.run(['claude', 'plugin', 'list', '--json'], { timeoutMs: 30000 }).catch(() => undefined)
  if (!listed || listed.exitCode !== 0) return 'modwall scan: could not run `claude plugin list --json`.'
  let plugins: Listed[]
  try {
    const parsed: unknown = JSON.parse(listed.stdout)
    if (!Array.isArray(parsed)) throw new Error('not a list')
    plugins = parsed.filter((p): p is Listed => typeof p === 'object' && p !== null && typeof (p as Listed).id === 'string')
  } catch {
    return 'modwall scan: `claude plugin list --json` did not return a JSON list.'
  }
  const lines = [`modwall scan: ${plugins.length} installed plugin(s)`]
  lines.push(`${pad('PLUGIN', 40)} ${pad('ON', 3)} ${pad('RISK', 6)} FOOTPRINT`)
  for (const p of plugins) {
    const root = p.readFromFolder ?? p.installPath
    const mcp = Object.keys(p.mcpServers ?? {})
    let risk = '-'
    const foot: string[] = []
    if (root && !isSafeRoot(root)) {
      foot.push(`skipped: folder is not an absolute path (${JSON.stringify(root)})`)
    } else if (root) {
      const out = await $.process.run(['claude', 'plugin', 'validate', '--json', root], { timeoutMs: 30000 }).catch(() => undefined)
      let report: ValidateReport | undefined
      try {
        report = out ? (JSON.parse(out.stdout) as ValidateReport) : undefined
      } catch {
        report = undefined
      }
      const uses = usesFromReport(report ?? {})
      const hasHooks = (report?.contents ?? []).some(c => c.type === 'hooks')
      if (uses.events.length || uses.calls.length) {
        const reach = reachOf(uses, p.id.split('@')[0])
        risk = riskOf(reach)
        foot.push(`mod: ${reach.join(', ') || 'known-safe uses only'}`)
      } else if (hasHooks) {
        foot.push('hooks.json without a hooks module (command hooks run as shell commands; not judged by plugin.register)')
      }
      if (!report) foot.push('validate failed')
    }
    if (mcp.length) foot.push(`MCP: ${mcp.join(', ')}`)
    lines.push(`${pad(p.id, 40)} ${pad(p.enabled === false ? 'no' : 'yes', 3)} ${pad(risk, 6)} ${foot.join('; ') || 'no mod, no MCP servers'}`)
  }
  return lines.join('\n')
}

const HELP = [
  '/modwall              mods seen this session: reach, risk, decision',
  '/modwall allow <name> [version|*]   allow a mod (a name seen this session, or name@marketplace; no version there means any version)',
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
  }).catch(async ($, e, next) => {
    if (next.called) return next(e)
    if (e.tier !== 'user') return next(e)
    if (mode !== 'audit') return { refuse: 'modwall could not check this mod, so it was not loaded' }
    // Audit mode still honours the blocklist when the check fails, as far as
    // it can be read here (a $ call rejects when this handler answers a re-entry).
    let block: unknown
    try {
      block = await $.store.get('block')
    } catch {
      return next(e)
    }
    if (Array.isArray(block) && isBlocked(e, block.filter(isString))) {
      return { refuse: `modwall: ${e.name} is on your blocklist` }
    }
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
    if (verb === '') return { text: table(await readSeen($), mode, await brokenKeys($)) }
    if (verb === 'allow' && arg) return { text: await allowCmd($, arg) }
    if (verb === 'block' && arg) return { text: await blockCmd($, arg) }
    if (verb === 'unblock' && arg) return { text: await unblockCmd($, arg) }
    if (verb === 'lists') return { text: await listsText($) }
    if (verb === 'log') return { text: logText(await $.store.get('log')) }
    if (verb === 'scan') return { text: await scan($) }
    return { text: HELP }
  })
}
