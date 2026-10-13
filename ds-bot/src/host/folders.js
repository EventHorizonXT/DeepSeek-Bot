// Working folders: where a Bot's Sessions run. A group's folder holds for every member
// there, else a Bot works in its own folder, else in the team workspace. A Session's
// folder is fixed when it is made, so a change moves the conversation on to a fresh
// part (parts.js).
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { unquote } from './text.js'

const PICK_TIMEOUT_MS = 10 * 60_000

export const within = (inner, outer) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep)

export function install(rt) {
  const { ctx, state } = rt

  const teamFolder = () => ctx.workspaceRegistry.get?.(state.workspaceId)?.path
  const workDirOf = ({ botId, roomId } = {}) => rt.roomOf(roomId)?.workDir ?? rt.botOf(botId)?.workDir
  const isFolder = path => stat(path).then(info => info.isDirectory(), () => false)
  const real = path => realpath(path).catch(() => resolve(path))

  // A Bot that could write where DSH or the team keeps its data could change its own
  // permissions or the team, so neither those folders nor one that holds them is allowed.
  async function guarded(path) {
    const team = teamFolder()
    for (const root of [rt.dshHome, rt.home]) {
      const data = await real(root)
      if (within(data, path)) return true
      if (within(path, data) && !(team !== undefined && within(path, team))) return true
    }
    return false
  }

  // Saved as the real path, which is what a Session's cwd shows. Undefined means the
  // team workspace.
  async function cleanWorkDir(input) {
    const text = unquote(input)
    if (text === '') return undefined
    const expanded = text === '~' ? homedir() : /^~[\\/]/.test(text) ? join(homedir(), text.slice(2)) : text
    if (!isAbsolute(expanded)) throw new Error(`Give the full path of the folder, not ${text}`)
    let path
    try {
      path = await realpath(expanded)
    } catch {
      throw new Error(`There is no folder at ${text}`)
    }
    if (!(await isFolder(path))) throw new Error(`${text} is a file, not a folder`)
    if (await guarded(path)) throw new Error(`${path} holds DeepSeek Harness data, so Bots cannot work there`)
    return path === teamFolder() ? undefined : path
  }

  // A folder outside the team workspace widens where a Bot may write, so a Bot that
  // sets one for Bots whose writes are bounded by their folder asks the user first.
  // `sessions` are the Sessions that would move; undefined stands for a Bot not made yet.
  // Throws when the user does not allow it.
  async function approveFolder(exec, { path, sessions, who }) {
    const team = teamFolder()
    const policy = ctx.get?.('sandboxPolicy')
    if (path === undefined || (team !== undefined && within(path, team)) || policy === undefined) return
    const modes = sessions === undefined ? [policy.resolve().mode]
      : await Promise.all(sessions.map(async id => policy.resolve({ session: (await rt.resolveAgent(id)).session }).mode))
    if (!modes.includes('workspace-write')) return
    const approval = ctx.get?.('approval')
    const agent = exec.agent
    if (approval === undefined || agent?.session === undefined) throw new Error('Setting this folder needs the user\'s approval, and there is no way to ask for it here. The user can set the folder in the settings.')
    if (approval.effectivePolicy?.(agent.session) === 'never') throw new Error('Your approval settings do not let you ask the user, so you cannot set this folder. The user can set it in the settings.')
    const outcome = await approval.request({
      agent,
      toolName: exec.name,
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
      reason: `Let ${who.en} work in ${path}? Files there can then be changed.`,
      displayReason: { en: `Let ${who.en} work in ${path}? Files there can then be changed.`, zh: `允许${who.zh}在 ${path} 中工作吗？之后可以修改这个文件夹里的文件。` },
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
    if (outcome === 'allowed-once') return
    throw new Error(outcome === 'rejected' ? 'The user did not allow this folder. Leave the folder as it is.'
      : outcome === 'cancelled' ? 'The approval was cancelled, so the folder stays as it is.'
        : 'Setting this folder needs the user\'s approval, and no one could answer. The user can set the folder in the settings.')
  }

  const picker = () => {
    try {
      return ctx.get?.('directoryPicker')?.capability()
    } catch {
      return undefined
    }
  }

  async function folderEndpoint(endpoint, body, signal) {
    switch (endpoint) {
      case 'folders': {
        const team = teamFolder() ?? null
        const known = new Map()
        for (const workspace of ctx.workspaceRegistry.list?.() ?? []) {
          if (workspace.path !== team) known.set(workspace.path, workspace.title)
        }
        for (const entry of [...Object.values(state.bots), ...Object.values(state.rooms)]) {
          if (entry.workDir && !known.has(entry.workDir)) known.set(entry.workDir, basename(entry.workDir) || entry.workDir)
        }
        const present = await Promise.all([...known].map(async ([path, title]) => (await isFolder(path) ? { path, title } : undefined)))
        const kind = picker()?.kind
        return {
          team,
          picker: kind === 'native' || kind === 'browse' ? kind : null,
          folders: present.filter(Boolean),
        }
      }
      case 'folder-pick': {
        const native = picker()
        if (native?.kind !== 'native') throw new Error('This DeepSeek Harness has no folder chooser')
        return await native.pick(AbortSignal.any([signal, AbortSignal.timeout(PICK_TIMEOUT_MS)].filter(Boolean)))
      }
      case 'folder-list': {
        const browse = picker()
        if (browse?.kind !== 'browse') throw new Error('This DeepSeek Harness cannot list folders')
        const listing = await browse.list(typeof body.path === 'string' && body.path !== '' ? body.path : undefined, signal)
        return { path: listing.path, home: listing.home, crumbs: listing.crumbs, entries: listing.entries, truncated: listing.truncated }
      }
      default:
        throw new Error(`Unknown endpoint ${endpoint}`)
    }
  }

  Object.assign(rt, { teamFolder, workDirOf, isFolder, cleanWorkDir, approveFolder, folderEndpoint })
}
