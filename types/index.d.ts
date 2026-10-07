// modwall's contract: the shapes it keeps in $.state and $.store.

export type ModwallRisk = 'low' | 'medium' | 'high'

/** One thing another mod can reach, read off its scanned `uses`. */
export type ModwallReach =
  | 'prompts'
  | 'network'
  | 'processes'
  | 'env'
  | 'secrets'
  | 'tool-gate'
  | 'system-prompt'
  | 'file-write'
  | 'file-read'
  | 'other-mods'
  | 'telemetry'

export type ModwallMode = 'audit' | 'ask' | 'allowlist'

export type ModwallStatus =
  | 'allowed'
  | 'flagged'
  | 'held'
  | 'blocked'
  | 'not-allowlisted'
  | 'not-judged'
  | 'check-failed'

/** One mod as modwall saw it load in this session. */
export type ModwallSeen = {
  name: string
  provenance: string
  version: string
  tier: string
  root: string
  reach: ModwallReach[]
  risk: ModwallRisk
  status: ModwallStatus
  reason: string
  isNotified: boolean
  at: number
}

/** An allowlist entry: a provenance at one version, or at any version ('*'). */
export type ModwallAllow = { provenance: string; version: string; at: number }

/** One line of the persistent decision log. */
export type ModwallLogEntry = {
  at: number
  name: string
  provenance: string
  version: string
  risk: ModwallRisk
  status: ModwallStatus
  reason: string
}

declare module 'claude-code' {
  interface PluginState {
    modwall: { seen: ModwallSeen[]; isStarted: boolean }
  }
}
