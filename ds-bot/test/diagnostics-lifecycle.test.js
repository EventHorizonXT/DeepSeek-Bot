import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createRuntime } from '../index.js'
import { install } from '../src/host/diagnostics.js'
import { fakeContext } from './fake-ctx.js'

function host(ctx = fakeContext(), config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-stop-'))
  const rt = { ctx, home, config }
  install(rt)
  return rt
}

function holdWrite(t, method, path) {
  let enter, release, complete
  const entered = new Promise(resolve => { enter = resolve })
  const held = new Promise(resolve => { release = resolve })
  const completed = new Promise(resolve => { complete = resolve })
  const original = fsp[method]
  const mock = t.mock.method(fsp, method, async (file, ...args) => {
    if (file !== path) return original(file, ...args)
    enter()
    await held
    try { return await original(file, ...args) } finally { complete() }
  })
  syncBuiltinESMExports()
  return { entered, release, completed, restore: () => { mock.mock.restore(); syncBuiltinESMExports() } }
}

for (const context of ['test context', 'Cordis plugin']) {
  test(`disposal drains queued diagnostics in a ${context}`, async (t) => {
    let rt, stop
    if (context === 'Cordis plugin') {
      const root = new Context()
      const fiber = root.plugin(ctx => { rt = host(ctx) })
      await fiber.await()
      stop = () => root.fiber.dispose()
    } else {
      rt = host()
      stop = () => rt.ctx.dispose()
    }
    const path = join(rt.home, 'logs', 'diagnostics.jsonl')
    const write = holdWrite(t, 'appendFile', path)
    let stopping
    try {
      rt.noteFailure({ text: 'first queued entry' })
      rt.noteFailure({ text: 'second queued entry' })
      await write.entered
      let done = false
      stopping = Promise.resolve(stop()).then(() => { done = true })
      await setImmediate()
      assert.equal(done, false, 'unloading must wait for the pending file write')
      write.release()
      await stopping
      assert.deepEqual(readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line).text), ['first queued entry', 'second queued entry'])
    } finally {
      write.release()
      await stopping
      await rt.diagnostics.clear()
      write.restore()
      rmSync(rt.home, { recursive: true, force: true })
    }
  })
}

test('disposal also waits for a queued diagnostics clear', async (t) => {
  const rt = host()
  const path = join(rt.home, 'logs', 'diagnostics.jsonl')
  // Ensure the directory exists before holding the clear itself.
  rt.noteFailure({ text: 'entry to clear' })
  await rt.diagnostics.clear()
  const write = holdWrite(t, 'writeFile', path)
  let clearing, stopping
  try {
    clearing = rt.diagnostics.clear()
    await write.entered
    let done = false
    stopping = rt.ctx.dispose().then(() => { done = true })
    await setImmediate()
    assert.equal(done, false, 'unloading must wait for a pending clear')
    write.release()
    await stopping
    assert.equal(readFileSync(path, 'utf8'), '')
  } finally {
    write.release()
    await clearing
    await stopping
    write.restore()
    rmSync(rt.home, { recursive: true, force: true })
  }
})

test('late notes and clear do not recreate files after disposal', async () => {
  const rt = host()
  try {
    await rt.ctx.dispose()
    rmSync(rt.home, { recursive: true, force: true })
    rt.noteFailure({ text: 'late completion' })
    await rt.diagnostics.clear()
    rt.noteFailure({ text: 'another late completion' })
    await setImmediate()
    assert.equal(existsSync(rt.home), false, 'stopped diagnostics must not create its directory again')
    assert.deepEqual((await rt.diagnostics.entries()).map(entry => entry.text), ['another late completion'])
  } finally {
    await rt.diagnostics.clear()
    rmSync(rt.home, { recursive: true, force: true })
  }
})

test('a diagnostics write failure settles disposal and is reported once', async (t) => {
  const rt = host()
  const path = join(rt.home, 'logs', 'diagnostics.jsonl')
  const stderr = []
  t.mock.method(console, 'error', (...args) => stderr.push(args.join(' ')))
  const original = fsp.appendFile
  const mock = t.mock.method(fsp, 'appendFile', async (file, ...args) => {
    if (file === path) throw Object.assign(new Error('synthetic write refusal'), { code: 'EACCES' })
    return original(file, ...args)
  })
  syncBuiltinESMExports()
  try {
    rt.noteFailure({ text: 'first entry' })
    rt.noteFailure({ text: 'second entry' })
    const settled = await rt.ctx.dispose()
    assert.ok(settled.every(result => result.status === 'fulfilled'))
    assert.deepEqual([...stderr], ['[ds-bot] diagnostics log not written: EACCES'])
  } finally {
    await rt.diagnostics.clear()
    mock.mock.restore()
    syncBuiltinESMExports()
    rmSync(rt.home, { recursive: true, force: true })
  }
})

test('disabled file diagnostics remain usable through disposal without writing', async () => {
  const rt = host(fakeContext(), { diagnosticsFile: false })
  try {
    rt.noteFailure({ text: 'in memory only' })
    await rt.ctx.dispose()
    assert.deepEqual((await rt.diagnostics.entries()).map(entry => entry.text), ['in memory only'])
    assert.deepEqual(await fsp.readdir(rt.home), [])
  } finally {
    rmSync(rt.home, { recursive: true, force: true })
  }
})

test('failed connector and retry diagnostics finish before the whole plugin stops', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-connector-stop-'))
  await fsp.writeFile(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['chief'], revision: 1,
    bots: { chief: { id: 'chief', sessionId: 'chief', name: 'Chief' } },
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
  }))
  const plugin = { name: 'test-mcp-client', apply() {} }
  const ctx = fakeContext({ services: { loader: { import: async () => ({ default: plugin }) } } })
  let mounts = 0, unmounts = 0
  ctx.plugin = () => {
    mounts++
    return {
      await: async () => { throw new Error('synthetic connector refusal') },
      dispose: () => { unmounts++ },
    }
  }
  let route
  ctx.connection.fetch.register = value => { route = value; return () => {} }
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ login: 'test-user' }) }))
  t.mock.method(console, 'error', () => {})
  const rt = createRuntime(ctx, { home, github: { api: 'https://github.invalid' } })
  const path = join(home, 'logs', 'diagnostics.jsonl')
  const write = holdWrite(t, 'appendFile', path)
  let stopping
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }),
    }))
    const result = await response.json()
    assert.equal(result.ok, true, result.error?.message)
    return result.value
  }
  try {
    const connected = await call('connector-connect', { id: 'github', token: 'test-connector-value' })
    assert.equal(connected[0].state, 'error')
    await call('connector-retry', { id: 'github' })
    await write.entered
    let done = false
    stopping = ctx.dispose().then(() => { done = true })
    await setImmediate()
    assert.equal(done, false, 'the failed connector warnings must be persisted before cleanup')
    write.release()
    await stopping
    assert.equal(mounts, 2)
    assert.equal(unmounts, 2)
    const entries = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(entries.length, 2)
    assert.ok(entries.every(entry => entry.text === 'GitHub connector failed: synthetic connector refusal'))
  } finally {
    write.release()
    await stopping
    await ctx.dispose()
    await rt.diagnostics.clear()
    write.restore()
    rmSync(home, { recursive: true, force: true })
  }
})

test('another disposer can report a late failure without extending the file queue', async (t) => {
  const rt = host()
  const path = join(rt.home, 'logs', 'diagnostics.jsonl')
  const write = holdWrite(t, 'appendFile', path)
  let finish, reported
  const teardown = new Promise(resolve => { finish = resolve })
  const noted = new Promise(resolve => { reported = resolve })
  rt.ctx.effect(() => async () => {
    await teardown
    rt.noteFailure({ text: 'late shutdown failure' })
    reported()
  }, 'test: late cleanup')
  let stopping, lateMkdir
  try {
    rt.noteFailure({ text: 'queued before shutdown' })
    await write.entered
    lateMkdir = t.mock.method(fsp, 'mkdir')
    syncBuiltinESMExports()
    stopping = rt.ctx.dispose()
    finish()
    await noted
    write.release()
    await stopping
    await write.completed
    await setImmediate()
    assert.equal(lateMkdir.mock.callCount(), 0, 'late teardown reports must not start new file work')
    assert.deepEqual(readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line).text), ['queued before shutdown'])
    assert.deepEqual((await rt.diagnostics.entries()).map(entry => entry.text), ['queued before shutdown', 'late shutdown failure'])
  } finally {
    finish()
    write.release()
    await stopping
    await rt.diagnostics.clear()
    lateMkdir?.mock.restore()
    write.restore()
    rmSync(rt.home, { recursive: true, force: true })
  }
})
