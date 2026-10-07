import { describe, expect, test } from 'claude-code/testing'

import { decide, patternHits, reachOf, riskOf, usesFromNotes } from './classify'

describe('reach and risk', () => {
  test('a ui-only mod is low risk', () => {
    const reach = reachOf({ events: ['ui.render', 'session.start'], calls: ['ui.toast', 'state.get'] })
    expect(reach).toEqual([])
    expect(riskOf(reach)).toBe('low')
  })

  test('reading prompts and env is medium', () => {
    const reach = reachOf({ events: ['prompt.submit'], calls: ['env.get'], env: { reads: ['HOME'], writes: [] } })
    expect(reach).toEqual(['prompts', 'env'])
    expect(riskOf(reach)).toBe('medium')
  })

  test('network, processes, secrets, tool gates and system prompt are high', () => {
    const uses = {
      events: ['tool.call', 'prompt.section'],
      calls: ['http.fetch', 'process.spawn', 'fs.write'],
      env: { reads: ['GITHUB_TOKEN'], writes: [] },
    }
    const reach = reachOf(uses)
    expect(reach).toEqual(['network', 'processes', 'env', 'secrets', 'tool-gate', 'system-prompt', 'file-write'])
    expect(riskOf(reach)).toBe('high')
  })

  test('wildcards count as everything they match', () => {
    expect(reachOf({ events: ['*'], calls: [] })).toEqual(['prompts', 'tool-gate', 'system-prompt', 'other-mods'])
    expect(reachOf({ events: ['tool.*'], calls: [] })).toEqual(['tool-gate'])
    expect(reachOf({ events: ['classic.*'], calls: [] })).toEqual(['prompts', 'tool-gate'])
    expect(patternHits('!tool.describe', 'tool.call')).toBe(true)
    expect(patternHits('*', 'telemetry.log')).toBe(false)
  })

  test('a mod that judges other mods is high', () => {
    expect(riskOf(reachOf({ events: ['plugin.register'], calls: [] }))).toBe('high')
  })
})

describe('decide', () => {
  const mod = { name: 'x', provenance: 'x@m', version: '1.0.0', tier: 'user' }

  test('audit allows and flags a new high-risk mod once', () => {
    expect(decide('audit', mod, 'high', [], [], false)).toMatchObject({ isRefused: false, status: 'flagged', shouldNotify: true })
    expect(decide('audit', mod, 'high', [], [], true)).toMatchObject({ isRefused: false, status: 'flagged', shouldNotify: false })
    expect(decide('audit', mod, 'low', [], [], false)).toMatchObject({ isRefused: false, status: 'allowed' })
  })

  test('ask holds high risk only', () => {
    expect(decide('ask', mod, 'high', [], [], false)).toMatchObject({ isRefused: true, status: 'held' })
    expect(decide('ask', mod, 'medium', [], [], false)).toMatchObject({ isRefused: false })
  })

  test('allowlist keys on provenance and version', () => {
    expect(decide('allowlist', mod, 'low', [], [], false)).toMatchObject({ isRefused: true, status: 'not-allowlisted' })
    const exact = [{ provenance: 'x@m', version: '1.0.0', at: 0 }]
    const other = [{ provenance: 'x@m', version: '0.9.0', at: 0 }]
    const any = [{ provenance: 'x@m', version: '*', at: 0 }]
    expect(decide('allowlist', mod, 'high', exact, [], false).isRefused).toBe(false)
    expect(decide('allowlist', mod, 'high', other, [], false).isRefused).toBe(true)
    expect(decide('allowlist', mod, 'high', any, [], false).isRefused).toBe(false)
  })

  test('the blocklist wins in every mode, and other tiers are not judged', () => {
    const any = [{ provenance: 'x@m', version: '*', at: 0 }]
    expect(decide('audit', mod, 'low', any, ['x'], false)).toMatchObject({ isRefused: true, status: 'blocked' })
    expect(decide('allowlist', { ...mod, tier: 'append' }, 'high', [], ['x'], false)).toMatchObject({
      isRefused: false,
      status: 'not-judged',
    })
  })
})

test('reads uses back from validate notes', () => {
  const uses = usesFromNotes([
    './register.ts hooks: prompt.submit, tool.*',
    './register.ts gating hook without .catch: tool.*',
    './register.ts calls: $.env.get, $.http.fetch',
    './register.ts env writes: nothing',
    './register.ts env reads: GITHUB_TOKEN',
  ])
  expect(uses).toEqual({
    events: ['prompt.submit', 'tool.*'],
    calls: ['env.get', 'http.fetch'],
    env: { reads: ['GITHUB_TOKEN'], writes: [] },
  })
})
