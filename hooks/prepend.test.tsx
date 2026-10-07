import { expect, mock, test, tier } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'

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

test('when its check fails it refuses user mods outside audit mode', { options: { mode: 'ask' }, plugins: [early] }, async ($, on) => {
  // No clock beneath the plugin: judge throws, and the .catch answers.
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  let message = ''
  try {
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  } catch (err) {
    message = (err as Error).message
  }
  expect(message).toBe('early: refused by modwall: modwall could not check this mod, so it was not loaded')
})
