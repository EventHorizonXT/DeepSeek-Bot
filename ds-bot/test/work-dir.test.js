import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { escapeRegExp } from '../src/host/text.js'
import { fakeContext } from './fake-ctx.js'

// A Main Bot and a Bot, with the Bot in the group Ops through its group Session 'gb'.
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'gb' } } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

// DSH_HOME, the team's data inside it, and a project folder beside it. Every Session
// starts in the team workspace unless it is made with a cwd. `services` are what
// ctx.get finds, such as the sandbox policy and approvals.
async function start({ services = {}, workspaces = [] } = {}) {
  // The native realpath, as fs/promises uses: on Windows the JS one keeps 8.3 short names.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-work-dir-')))
  const dsh = join(root, 'dsh')
  const home = join(dsh, 'bot')
  const team = join(home, 'workspace')
  const project = join(root, 'project')
  for (const dir of [team, project]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dsh

  const ctx = fakeContext({ services })
  const created = []
  const cwds = new Map()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        id: sessionId,
        session: { id: sessionId, header: { cwd: cwds.get(sessionId) ?? team }, requestHeader: () => undefined, deriveMessages: () => [] },
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(sessionId)
  }
  const registry = new Map([['w1', { id: 'w1', path: team, title: 'DS Bot' }], ...workspaces.map(workspace => [workspace.id, workspace])])
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: id => registry.get(id),
      list: () => [...registry.values()],
      resolveByPath: async path => [...registry.values()].find(workspace => workspace.path === path),
      create: async path => ({ id: 'w-new', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async (options) => {
        const sessionId = `s${created.length + 1}`
        created.push(options)
        cwds.set(sessionId, options.cwd ?? registry.get(options.workspaceId)?.path)
        return { sessionId }
      },
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: agentOf(sessionId), name, callId: 'c1' })
  // Runs the parts check, registered last; 'next' means the step goes on.
  const preStep = (sessionId, messages = []) => ctx.listeners.get('agent/pre-step').at(-1)(
    { agent: agentOf(sessionId), messages, step: 1, signal: AbortSignal.timeout(60_000) }, async () => 'next')
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  // Waits until the Bot's own chat runs in `dir` and its move has finished.
  const workingIn = async (botId, dir) => {
    await until(() => agentOf(state().bots[botId].sessionId).session.header.cwd === dir)
    await settle()
  }
  const stop = () => {
    ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  // Loading once fills the Session-owner indexes.
  await tool('list_bots', {}, 'a')
  return { ctx, root, dsh, home, team, project, created, agentOf, call, tool, preStep, state, workingIn, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const until = async (check) => {
  const end = Date.now() + 2000
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold within 2 s')
    await settle()
  }
}
const textOf = message => message.content.map(block => block.text ?? '').join('\n')
const handoffOf = agent => agent.calls.filter(([kind, message]) => kind === 'followup' && message.source?.role === 'handoff').map(([, message]) => textOf(message)).at(-1)

// Approvals that answer `outcome` and keep every request; Sessions write inside their
// folder only.
const approvalServices = (outcome, { policy = 'on-request' } = {}) => {
  const requests = []
  return {
    requests,
    services: {
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
      approval: {
        effectivePolicy: () => policy,
        request: async (request) => {
          requests.push(request)
          return outcome
        },
      },
    },
  }
}

test('a working folder is a full path to a folder outside the DeepSeek Harness data', async (t) => {
  const { call, state, workingIn, dsh, home, team, root, project, stop } = await start()
  t.after(stop)
  const error = async workDir => (await call('update-bot', { id: 'b', workDir })).error?.message
  assert.equal(await error('project'), 'Give the full path of the folder, not project')
  assert.equal(await error(join(root, 'missing')), `There is no folder at ${join(root, 'missing')}`)
  writeFileSync(join(project, 'notes.txt'), 'x')
  assert.equal(await error(join(project, 'notes.txt')), `${join(project, 'notes.txt')} is a file, not a folder`)
  // DSH_HOME, the team's data, and any folder that holds them are refused.
  for (const guarded of [dsh, home, root]) assert.equal(await error(guarded), `${guarded} holds DeepSeek Harness data, so Bots cannot work there`)
  // The team workspace and a folder inside it are fine; the workspace itself is no setting.
  assert.equal(state().bots.b.workDir, undefined)
  mkdirSync(join(team, 'site'))
  assert.equal((await call('update-bot', { id: 'b', workDir: join(team, 'site') })).value.workDir, join(team, 'site'))
  assert.equal((await call('update-bot', { id: 'b', workDir: team })).value.workDir, undefined)
  assert.equal(state().bots.b.workDir, undefined)
  // A quoted path and a trailing separator name the same folder.
  assert.equal((await call('update-bot', { id: 'b', workDir: `"${project}/"` })).value.workDir, project)
  assert.equal(state().bots.b.workDir, project)
  // Changed again while it moved, the chat still ends up in the last folder.
  await workingIn('b', project)
})

test('a new Bot with a folder starts its Session there; others start in the team workspace', async (t) => {
  const { call, created, project, state, stop } = await start()
  t.after(stop)
  const made = (await call('create-bot', { name: 'Builder', workDir: project })).value
  assert.equal(made.workDir, project)
  assert.deepEqual(created.at(-1), { cwd: project })
  assert.equal(state().bots[made.id].workDir, project)
  await call('create-bot', { name: 'Plain' })
  assert.deepEqual(created.at(-1), { workspaceId: 'w1' })
  // A copy works in the same folder.
  await call('duplicate-bot', { id: made.id })
  assert.deepEqual(created.at(-1), { cwd: project })
})

test('an idle Bot\'s own chat moves to its new folder at once, and back', async (t) => {
  const { call, created, agentOf, project, team, state, stop } = await start()
  t.after(stop)
  assert.equal((await call('update-bot', { id: 'b', workDir: project })).ok, true)
  await until(() => state().bots.b.sessionId === 's1')
  assert.deepEqual(created, [{ cwd: project }])
  assert.deepEqual(state().bots.b.segments.map(segment => [segment.sessionId, segment.fallback]), [['b', 'whole']])
  const moved = handoffOf(agentOf('s1'))
  assert.match(moved, new RegExp(`part 2, because your working folder changed to ${escapeRegExp(project)}\\.`))
  assert.match(moved, new RegExp(`You now work in ${escapeRegExp(project)}: commands and file tools start there\\.`))
  assert.match(moved, /No new note: every message of the part was carried over word for word\./)

  assert.equal((await call('update-bot', { id: 'b', workDir: '' })).ok, true)
  await until(() => state().bots.b.sessionId === 's2')
  assert.deepEqual(created.at(-1), { workspaceId: 'w1' })
  assert.match(handoffOf(agentOf('s2')), new RegExp(`because your working folder changed to ${escapeRegExp(team)}\\.`))
})

test('a running Bot moves at its next step and carries that step\'s input along', async (t) => {
  const { requests, services } = approvalServices('allowed-once')
  const { tool, preStep, agentOf, created, project, state, stop } = await start({ services })
  t.after(stop)
  agentOf('b').status = 'running'
  assert.equal(await tool('update_bot', { work_dir: project }, 'b'), `Updated Writer. From your next step on, you work in ${project}.`)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].reason, `Let Writer work in ${project}? Files there can then be changed.`)
  assert.equal(requests[0].toolName, 'update_bot')
  await settle()
  assert.deepEqual(created, [])

  const input = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Now build it' }], source: { kind: 'user' } }
  assert.deepEqual(await preStep('b', [input]), { kind: 'reject' })
  await until(() => state().bots.b.sessionId === 's1')
  assert.deepEqual(created, [{ cwd: project }])
  await until(() => agentOf('s1').calls.length >= 2)
  assert.deepEqual(agentOf('s1').calls.map(([kind, message]) => [kind, message.source.role ?? textOf(message)]), [['followup', 'handoff'], ['followup', 'Now build it']])
  // The fresh part is where it should be, so its steps go on.
  assert.equal(await preStep('s1'), 'next')
})

test('a folder outside the team workspace needs the user\'s approval', async (t) => {
  const rejected = approvalServices('rejected')
  const first = await start({ services: rejected.services })
  t.after(first.stop)
  assert.equal(await first.tool('update_bot', { work_dir: first.project }, 'b'), 'Could not update the Bot: The user did not allow this folder. Leave the folder as it is.')
  assert.equal(first.state().bots.b.workDir, undefined)
  assert.match(await first.tool('create_bot', { name: 'Builder', role: 'Build', instructions: 'Build', work_dir: first.project }, 'a'), /^Could not create the Bot: The user did not allow this folder/)
  assert.deepEqual(first.created, [])
  // A folder inside the team workspace widens nothing, so nobody is asked.
  mkdirSync(join(first.team, 'site'))
  assert.equal(await first.tool('update_bot', { work_dir: join(first.team, 'site') }, 'b'), `Updated Writer. From your next step on, you work in ${join(first.team, 'site')}.`)
  assert.equal(rejected.requests.length, 2)
  assert.deepEqual(rejected.requests[1].displayReason, { en: `Let the new Bot Builder work in ${first.project}? Files there can then be changed.`, zh: `允许新 Bot Builder 在 ${first.project} 中工作吗？之后可以修改这个文件夹里的文件。` })
  await first.workingIn('b', join(first.team, 'site'))

  const never = await start(approvalServices('allowed-once', { policy: 'never' }))
  t.after(never.stop)
  assert.equal(await never.tool('update_bot', { work_dir: never.project }, 'b'), 'Could not update the Bot: Your approval settings do not let you ask the user, so you cannot set this folder. The user can set it in the settings.')

  const allowed = approvalServices('allowed-once')
  const third = await start({ services: allowed.services })
  t.after(third.stop)
  assert.equal(await third.tool('create_bot', { name: 'Builder', role: 'Build', instructions: 'Build', work_dir: third.project }, 'a'), `Created Builder, working in ${third.project}. It is greeting the user now.`)
  assert.deepEqual(third.created, [{ cwd: third.project }])
  assert.match(await third.tool('list_bots', {}, 'a'), new RegExp(`- Builder \\(Build, works in ${escapeRegExp(third.project)}\\)`))
})

test('a group\'s folder holds for every member there; only the user or a Main Bot sets it', async (t) => {
  const { requests, services } = approvalServices('allowed-once')
  const { call, tool, preStep, created, project, state, stop } = await start({ services })
  t.after(stop)
  // The admin may change the group, but not its folder.
  assert.equal(await tool('update_group', { group: 'Ops', work_dir: project }, 'gb'), 'Only a Main Bot can set the folder of "Ops".')
  assert.equal((await call('update-room', { id: 'r1', workDir: project })).ok, true)
  assert.equal(state().rooms.r1.workDir, project)
  assert.equal(requests.length, 0)
  assert.match(await tool('list_bots', {}, 'a'), new RegExp(`"Ops" — .*; members work in ${escapeRegExp(project)} here`))

  // The member's group Session moves at its next turn there; its own chat stays.
  assert.equal(await preStep('b'), 'next')
  assert.deepEqual(await preStep('gb'), { kind: 'reject' })
  await until(() => state().rooms.r1.sessions.b === 's1')
  assert.deepEqual(created, [{ cwd: project }])
  assert.equal(state().bots.b.sessionId, 'b')

  // A Main Bot clears it without asking; setting it asks the user once for every member.
  assert.equal(await tool('update_group', { group: 'Ops', work_dir: '' }, 'a'), 'Updated "Ops": every member works in its own folder again.')
  assert.equal(state().rooms.r1.workDir, undefined)
  assert.equal(requests.length, 0)
  assert.match(await tool('update_group', { group: 'Ops', work_dir: project }, 'a'), /^Updated "Ops": every member now works in .* here\.$/)
  assert.equal(requests[0].displayReason.zh, `允许群聊「Ops」的成员在 ${project} 中工作吗？之后可以修改这个文件夹里的文件。`)
})

test('the folder menu lists DSH projects and the folders Bots use, but not the team workspace', async (t) => {
  const { call, workingIn, root, project, team, stop } = await start({ workspaces: [{ id: 'w2', path: join(rootless(), 'gone'), title: 'Gone' }] })
  t.after(stop)
  const other = join(root, 'other')
  mkdirSync(other)
  await call('update-bot', { id: 'b', workDir: project })
  await workingIn('b', project)
  await call('update-room', { id: 'r1', workDir: other })
  assert.deepEqual((await call('folders', {})).value, {
    team,
    picker: null,
    folders: [{ path: project, title: 'project' }, { path: other, title: 'other' }],
  })
  assert.equal((await call('folder-pick', {})).error.message, 'This DeepSeek Harness has no folder chooser')
})

test('the folder menu browses through the DSH folder picker', async (t) => {
  const asked = []
  const directoryPicker = {
    capability: () => ({
      kind: 'browse',
      list: async (path) => {
        asked.push(path)
        return { path: path ?? '/srv/team', home: '/srv/team', crumbs: [], entries: [{ name: 'code', path: '/srv/team/code' }], truncated: false, extra: 'x' }
      },
    }),
  }
  const { call, stop } = await start({ services: { directoryPicker } })
  t.after(stop)
  assert.equal((await call('folders', {})).value.picker, 'browse')
  assert.deepEqual((await call('folder-list', {})).value, { path: '/srv/team', home: '/srv/team', crumbs: [], entries: [{ name: 'code', path: '/srv/team/code' }], truncated: false })
  await call('folder-list', { path: '/srv/team/code' })
  assert.deepEqual(asked, [undefined, '/srv/team/code'])
})

// A path under no temporary folder of these tests, so nothing is there.
function rootless() {
  return join(tmpdir(), `ds-bot-work-dir-none-${process.pid}`)
}
