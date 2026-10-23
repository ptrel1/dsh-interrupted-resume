/**
 * 离线探针：不启动 dsh，直接对真实 ~/.dsh/sessions 调 scanOnce 的筛选逻辑。
 * 用法：node tools/probe.mjs            —— 只统计（dryRun 强制 true）
 *       node tools/probe.mjs --inspect  —— 额外打印候选会话的明细
 * 目的：先证明「筛选」在真实数据上是对的，再谈「注入」。
 */
import { DEFAULTS, withinWindow, tailTurnEnd, buildPromptText, requestIdFor } from '../lib/index.js'
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const HOME = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
const SESSIONS = join(HOME, 'sessions')
const now = Date.now()
const WINDOW = Number(process.env.PROBE_WINDOW_MS ?? DEFAULTS.promptWindowMs)

function tailOf(filePath) {
  if (!existsSync(filePath)) return undefined
  let text
  try {
    text = zstdDecompressSync(readFileSync(filePath)).toString('utf8')
  } catch {
    return undefined
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e?.type === 'turn/end') return { kind: String(e?.data?.reason?.kind ?? ''), time: Number(e.time ?? 0), turn: Number(e?.data?.turn ?? -1) }
  }
  return undefined
}

function lastUserMessageAt(filePath) {
  if (!existsSync(filePath)) return 0
  let text
  try { text = zstdDecompressSync(readFileSync(filePath)).toString('utf8') } catch { return 0 }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e?.type === 'user/message' && e?.data?.source?.kind === 'user') return Number(e.time ?? 0)
  }
  return 0
}

const stats = { scanned: 0, inWindow: 0, interrupted: 0, aborted: 0, other: 0 }
const hits = []
const byKind = {}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (!st.isDirectory()) continue
    if (name.startsWith('session-')) {
      const f = ['session.v4.jsonl.zstd', 'session.jsonl.zstd', 'session.v3.jsonl.zstd']
        .map(n => join(p, n)).find(q => existsSync(q))
      if (!f) continue
      stats.scanned++
      const tail = tailOf(f)
      const kind = tail?.kind ?? 'none'
      byKind[kind] = (byKind[kind] ?? 0) + 1
      if (kind === 'interrupted') stats.interrupted++
      else if (kind === 'aborted') stats.aborted++
      else stats.other++
      const lastUser = lastUserMessageAt(f)
      const inWindow = lastUser > 0 && now - lastUser <= WINDOW
      if (inWindow) {
        stats.inWindow++
        if (kind === 'interrupted') hits.push({ dir: name, mtime: new Date(Math.max(lastUser, tail?.time ?? 0)).toISOString(), turn: tail.turn })
      }
    } else {
      walk(p)
    }
  }
}

if (!existsSync(SESSIONS)) {
  console.log('no sessions dir: ' + SESSIONS)
  process.exit(1)
}
walk(SESSIONS)
console.log('DSH_HOME      =', HOME)
console.log('window(ms)    =', WINDOW, '(' + (WINDOW / 3600000).toFixed(1) + 'h)')
console.log('scanned       =', stats.scanned)
console.log('last user <= window =', stats.inWindow)
console.log('turn/end kinds =', JSON.stringify(byKind))
console.log('=> interrupted & in-window candidates =', hits.length)
for (const h of hits.slice(0, 20)) console.log('   -', h.dir, 'turn', h.turn, h.mtime)
console.log('')
console.log('--- 注入文本样例 ---')
console.log(buildPromptText(7))
console.log('')
console.log('--- 幂等 requestId 样例 ---')
console.log(requestIdFor('session-abc', 7))
