import { describe, expect, test } from 'claude-code/testing'

import { decide, patternHits, reachOf, resolveTarget, riskOf, usesFromReport } from './classify'

const risk = (uses: Parameters<typeof reachOf>[0], name?: string) => riskOf(reachOf(uses, name))

describe('reach and risk: only the known-safe set is low', () => {
  test('drawing, toasts, clock, own store and state, command.register are low', () => {
    const uses = {
      events: ['session.start', 'session.end', 'turn.start'],
      calls: ['ui.toast', 'ui.status', 'ui.resolve', 'ui.invalidate', 'clock.now', 'clock.every', 'store.get', 'store.set', 'state.get', 'state.set', 'command.register'],
      state: { reads: [{ plugin: 'me' }], writes: [{ plugin: 'me' }] },
    }
    expect(reachOf(uses, 'me')).toEqual([])
    expect(risk(uses, 'me')).toBe('low')
  })

  test('read-only session facts are low, but session.messages stays high', () => {
    const uses = { events: [], calls: ['session.cwd', 'session.root', 'session.model', 'session.turns', 'session.id', 'session.surfaces', 'session.surface', 'session.version'] }
    expect(reachOf(uses)).toEqual([])
    expect(risk(uses)).toBe('low')
    expect(risk({ events: [], calls: ['session.cwd', 'session.messages'] })).toBe('high')
  })

  test('reading env vars with ordinary names is medium; secret-looking names are high', () => {
    expect(reachOf({ events: [], calls: ['env.get'], env: { reads: ['HOME'], writes: [] } })).toEqual(['env'])
    expect(risk({ events: [], calls: ['env.get'], env: { reads: ['HOME'], writes: [] } })).toBe('medium')
    expect(reachOf({ events: [], calls: ['env.get'], env: { reads: ['GITHUB_TOKEN'], writes: [] } })).toEqual(['secret-names'])
    expect(risk({ events: [], calls: ['env.set'] })).toBe('high')
  })

  test('calls outside the safe set are high', () => {
    const cases: [string, string][] = [
      ['http.fetch', 'network'],
      ['process.run', 'processes'],
      ['fs.read', 'file-read'],
      ['fs.write', 'file-write'],
      ['tool.call', 'tool-calls'],
      ['mcp.call', 'tool-calls'],
      ['session.append', 'prompts'],
      ['session.messages', 'prompts'],
      ['model.complete', 'prompts'],
      ['agent.spawn', 'agents'],
      ['command.run', 'commands'],
      ['ui.copy', 'screen'],
      ['ui.ask', 'screen'],
      ['session.usage', 'unknown'],
      ['session.repo', 'unknown'],
      ['audio.speak', 'unknown'],
      ['brand.new', 'unknown'],
    ]
    for (const [call, label] of cases) {
      expect(reachOf({ events: [], calls: [call] })).toEqual([label])
      expect(risk({ events: [], calls: [call] })).toBe('high')
    }
  })

  test('events outside the safe set are high', () => {
    const cases: [string, string][] = [
      ['prompt.submit', 'prompts'],
      ['prompt.fill', 'prompts'],
      ['prompt.edit', 'prompts'],
      ['prompt.attachment', 'prompts'],
      ['session.send', 'prompts'],
      ['session.receive', 'prompts'],
      ['session.compact', 'prompts'],
      ['turn.complete', 'prompts'],
      ['tool.call', 'tool-gate'],
      ['tool.check', 'tool-gate'],
      ['prompt.section', 'system-prompt'],
      ['plugin.register', 'other-mods'],
      ['engine.create', 'other-mods'],
      ['agent.spawn', 'agents'],
      ['config.set', 'config'],
      ['command.run', 'commands'],
      ['ui.render', 'screen'],
      ['ui.input', 'screen'],
      ['telemetry.log', 'telemetry'],
      ['some.future.event', 'unknown'],
    ]
    for (const [event, label] of cases) {
      expect(reachOf({ events: [event], calls: [] })).toEqual([label])
      expect(risk({ events: [event], calls: [] })).toBe('high')
    }
  })

  test('a hook on a $ call name intercepts that call for every mod, so it is high', () => {
    for (const event of ['store.get', 'store.set', 'http.fetch', 'process.run', 'fs.write', 'env.get', 'clock.now', 'ui.toast']) {
      expect(reachOf({ events: [event], calls: [] })).toEqual(['intercepts-api'])
    }
  })

  test('a bare command.run or ui.render hook is high; verified own-command and pane hooks are low', () => {
    expect(risk({ events: ['command.run'], calls: [] })).toBe('high')
    expect(risk({ events: ['ui.render'], calls: [] })).toBe('high')
    expect(risk({ events: ['command.run(own)', 'ui.render(pane)'], calls: [] })).toBe('low')
  })

  test("reading or writing another mod's state is high", () => {
    const uses = { events: [], calls: ['state.get'], state: { reads: [{ plugin: 'other' }], writes: [] } }
    expect(reachOf(uses, 'me')).toEqual(['other-mods'])
  })

  test('wildcards are high and name what they cover', () => {
    expect(reachOf({ events: ['*'], calls: [] })).toEqual([
      'wildcard', 'prompts', 'tool-gate', 'system-prompt', 'other-mods', 'agents', 'config', 'commands', 'screen',
    ])
    expect(reachOf({ events: ['tool.*'], calls: [] })).toEqual(['wildcard', 'tool-gate'])
    expect(reachOf({ events: ['session.*'], calls: [] })).toEqual(['wildcard', 'prompts'])
    expect(patternHits('!tool.describe', 'tool.call')).toBe(true)
    expect(patternHits('*', 'telemetry.log')).toBe(false)
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

  test('allowlist keys on provenance and declared version', () => {
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
    expect(decide('allowlist', { ...mod, tier: 'append' }, 'high', [], ['x'], false)).toMatchObject({ isRefused: false, status: 'not-judged' })
  })

  test('damaged stored lists refuse in ask and allowlist, keep the blocklist, and are reported in audit', () => {
    const any = [{ provenance: 'x@m', version: '*', at: 0 }]
    expect(decide('allowlist', mod, 'low', any, [], false, true)).toMatchObject({ isRefused: true, status: 'check-failed' })
    expect(decide('ask', mod, 'low', [], [], false, true)).toMatchObject({ isRefused: true, status: 'check-failed' })
    expect(decide('audit', mod, 'low', [], [], false, true)).toMatchObject({ isRefused: false, status: 'check-failed', shouldNotify: true })
    expect(decide('audit', mod, 'low', [], ['x'], false, true)).toMatchObject({ isRefused: true, status: 'blocked' })
  })
})

describe('resolveTarget', () => {
  const seen = [
    { name: 'a', provenance: 'a@one', version: '1.0.0' },
    { name: 'a', provenance: 'a@two', version: '2.0.0' },
    { name: 'b', provenance: 'b@one', version: '3.0.0' },
  ]

  test('a unique name resolves to its provenance and version', () => {
    expect(resolveTarget(seen, 'b')).toEqual({ provenance: 'b@one', version: '3.0.0', isAnyVersion: false })
  })

  test('an ambiguous name asks for the provenance', () => {
    expect(resolveTarget(seen, 'a')).toContain('more than one mod named "a" was seen (a@one, a@two)')
    expect(resolveTarget(seen, 'a@two')).toEqual({ provenance: 'a@two', version: '2.0.0', isAnyVersion: false })
  })

  test('an unseen id with no version means any version', () => {
    expect(resolveTarget(seen, 'c@m')).toEqual({ provenance: 'c@m', version: '*', isAnyVersion: true })
    expect(resolveTarget(seen, 'c@m 1.2.3')).toEqual({ provenance: 'c@m', version: '1.2.3', isAnyVersion: false })
    expect(resolveTarget(seen, 'c')).toContain('no mod named "c"')
  })
})

describe('usesFromReport, on real `claude plugin validate --json` output', () => {
  // Captured from claude plugin validate --json (2.1.293), paths shortened.
  const modwallReport = {
    contents: [
      {
        file: '/p/modwall/hooks/hooks.json',
        type: 'hooks',
        notes: [
          './register.tsx hooks: plugin.register, session.start, command.run{command=modwall}',
          './register.tsx answers its own command: command.run{command=modwall}',
          './register.tsx gating hook with .catch: plugin.register',
          './register.tsx calls: $.clock.now (via allowCmd, judge), $.command.register, $.process.run (via scan), $.state.get (via judge, readSeen), $.state.set, $.store.get (via readArray), $.store.set (via allowCmd, blockCmd, judge, unblockCmd), $.ui.toast (via flushToasts, judge)',
          './register.tsx state writes: modwall.isStarted, modwall.seen',
          './register.tsx state reads: modwall.isStarted, modwall.seen',
        ],
        gatingHooks: [{ module: './register.tsx', pattern: 'plugin.register', hook: 'plugin.register', hasCatch: true }],
      },
    ],
  }
  const bandReport = {
    contents: [
      { file: '/p/relay-band/.claude-plugin/plugin.json', type: 'plugin', notes: [] },
      {
        file: '/p/relay-band/hooks/hooks.json',
        type: 'hooks',
        notes: [
          './register.tsx hooks: session.start, command.run{command=relay-status}, ui.render{component=AbovePrompt}',
          './register.tsx answers its own command: command.run{command=relay-status}',
          './register.tsx calls: $.clock.every, $.command.register, $.env.get (via pollOnce), $.process.run (via pollOnce), $.session.cwd (via pollOnce), $.state.get, $.state.set, $.ui.resolve, $.ui.toast (via pollOnce)',
          './register.tsx env writes: nothing',
          './register.tsx env reads: HOME',
          './register.tsx state writes: relay-band.error, relay-band.isHidden, relay-band.seen, relay-band.snap',
          './register.tsx state reads: relay-band.error, relay-band.isHidden, relay-band.seen, relay-band.snap',
        ],
        gatingHooks: [],
      },
    ],
  }

  test('modwall itself: (via ...) stripped, own command verified, rated high', () => {
    const uses = usesFromReport(modwallReport)
    expect(uses.events).toEqual(['plugin.register', 'session.start', 'command.run(own)'])
    expect(uses.calls).toEqual(['clock.now', 'command.register', 'process.run', 'state.get', 'state.set', 'store.get', 'store.set', 'ui.toast'])
    expect(reachOf(uses, 'modwall')).toEqual(['other-mods', 'processes'])
  })

  test('a status band: pane render, own command and cwd are safe; the process is not', () => {
    const uses = usesFromReport(bandReport)
    expect(uses.events).toEqual(['session.start', 'command.run(own)', 'ui.render(pane)'])
    expect(uses.env).toEqual({ reads: ['HOME'], writes: [] })
    expect(reachOf(uses, 'relay-band')).toEqual(['processes', 'env'])
    expect(riskOf(reachOf(uses, 'relay-band'))).toBe('high')
  })

  test('gating hooks from the structured field are counted even without a hooks note', () => {
    const uses = usesFromReport({
      contents: [{ type: 'hooks', notes: [], gatingHooks: [{ pattern: 'tool.call{tool=Bash}', hook: 'tool.call' }] }],
    })
    expect(uses.events).toEqual(['tool.call'])
    expect(riskOf(reachOf(uses))).toBe('high')
  })

  test('an unmatched command.run or a transcript render stays high', () => {
    const uses = usesFromReport({
      contents: [{ type: 'hooks', notes: ['./m.ts hooks: command.run, ui.render{component=UserMessage}, tool.call{tool=Bash, isReadOnly=false}'] }],
    })
    expect(uses.events).toEqual(['command.run', 'ui.render', 'tool.call'])
    expect(reachOf(uses)).toEqual(['commands', 'screen', 'tool-gate'])
  })
})
