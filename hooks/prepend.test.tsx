import { expect, mock, test, tier } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, Plugin } from 'claude-code/testing'

// Listed in prependPlugins, modwall loads ahead of every user mod and judges
// all of them, whatever order they were installed in.
tier('prepend')

const early: Plugin = {
  name: 'early',
  register(on) {
    on('tool.call', async ($, e, next) => next(e))
  },
}

test('at the prepend tier it judges user mods', { options: { mode: 'allowlist' }, plugins: [early] }, async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 0 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  let message = ''
  try {
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  } catch (err) {
    message = (err as Error).message
  }
  expect(message).toContain('early: refused by modwall: modwall: early@')
})

// A store whose allowlist read throws makes modwall's check fail; `block`
// answers from `blocked`, so the .catch handler can still read it.
function failingStore(on: On, blocked: unknown) {
  on('store.get', ($, e) => {
    if (e.key === 'block') return { value: blocked }
    throw new Error('store unreadable')
  })
  on('store.set', () => ({ value: undefined }))
}

async function startAndCatch($: Engine): Promise<string> {
  try {
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  } catch (err) {
    return (err as Error).message
  }
  return ''
}

test('when its check fails it refuses user mods outside audit mode', { options: { mode: 'ask' }, plugins: [early] }, async ($, on) => {
  failingStore(on, undefined)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  expect(await startAndCatch($)).toBe('early: refused by modwall: modwall could not check this mod, so it was not loaded')
})

test('when its check fails in audit mode the blocklist still applies', { plugins: [early] }, async ($, on) => {
  failingStore(on, ['early'])
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  expect(await startAndCatch($)).toBe('early: refused by modwall: modwall: early is on your blocklist')
})

test('when its check fails in audit mode an unblocked mod loads', { plugins: [early] }, async ($, on) => {
  failingStore(on, undefined)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('state.set', () => ({ value: { isSet: true, version: 1 } }))
  expect(await startAndCatch($)).toBe('')
})
