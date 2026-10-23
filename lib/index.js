/**
 * dsh-interrupted-resume — host half.
 *
 * 目的：dsh 被重启（强杀 / 崩溃 / 手动重启）时，正在跑的 turn 会被 session
 * repair 逻辑合成一条 turn/end { reason: { kind: 'interrupted' } }。本插件在
 * 启动后扫描会话，对符合条件者注入一条「带状态核对要求」的继续指令。
 *
 * ⚠️ 为什么不能监听 session/event：
 *   'interrupted' 是冷读时由 repair 合成的，agent loop 从不实时发出它
 *   （见 @deepseek-ai/dsh-session types.d.ts 中 “the loop never emits this marker”）。
 *   因此只能启动后主动扫盘 / inspect。
 *
 * ⚠️ 为什么每次现取 ctx.get('sessionController') 而不缓存：
 *   同仓库 dsh-postapi-bridge 已踩坑（lib/index.js 的 sessionQueryOf 注释）：cordis
 *   服务激活时机不保证早于本插件 apply()，缓存到 undefined 就永久失效。
 *
 * 设计约束（与用户 20261023 确认的口径）：
 *   1. 只处理最近 12h 内有过人类提示词的会话；
 *   2. 只认 reason.kind === 'interrupted'（用户主动停止是 'aborted'，绝不碰）；
 *   3. 距中断至少静置 2 分钟，避开用户重启后马上打开该会话造成的 writer 竞争；
 *   4. 每会话最多自动续 2 次（防模型反复中断时 token 空转）；
 *   5. requestId 可推导，借用 prompt 自身的幂等检查做第二层防重。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

/** Stable cordis plugin name. */
export const name = 'interrupted-resume'

/** 只声明必需服务；可选能力一律用 ctx.get() 现取（不在 inject 里访问会 throw）。 */
export const inject = ['sessionController']

/** 默认配置：与确认口径一致。 */
const DEFAULTS = {
  promptWindowMs: 12 * 60 * 60 * 1000,
  startupDelayMs: 10 * 1000,
  quietMs: 2 * 60 * 1000,
  maxAttemptsPerSession: 2,
  enabled: true,
  dryRun: false,
}

function stateDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'interrupted-resume')
}

function ledgerPath() {
  return join(stateDir(), 'ledger.json')
}

function logPath() {
  return join(stateDir(), 'resume.log')
}

/** 读 ledger；损坏一律当空，绝不因账本问题阻断启动。 */
function readLedger() {
  const p = ledgerPath()
  if (!existsSync(p)) return { sessions: {} }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
      return parsed
    }
  } catch {
    // 账本损坏：按空处理，appendLog 会留下痕迹
  }
  return { sessions: {} }
}

/** 原子写 ledger（tmp + rename），失败只降级幂等强度不抛。 */
function writeLedger(ledger) {
  try {
    const p = ledgerPath()
    const dir = dirname(p)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = p + '.tmp'
    writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, p)
  } catch {
    // 账本不可写只影响幂等兜底，不影响本轮行为
  }
}

function appendLog(line) {
  try {
    const p = logPath()
    const dir = dirname(p)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(p, '[' + new Date().toISOString() + '] ' + line + '\n', { flag: 'a', encoding: 'utf8' })
  } catch {
    // 日志失败不影响主流程
  }
}

/** 安全取服务：未激活时返 undefined 而非 throw。 */
function serviceOf(ctx, key) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(key) : undefined
  } catch {
    return undefined
  }
}

/** 从事件数组里取最后一条 turn/end。 */
function tailTurnEndOf(events) {
  if (!Array.isArray(events)) return undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e?.type === 'turn/end') {
      return {
        kind: String(e?.data?.reason?.kind ?? ''),
        time: Number(e.time ?? 0),
        turn: Number(e?.data?.turn ?? -1),
      }
    }
  }
  return undefined
}

/**
 * 直接读会话日志文件取最后一条 turn/end（调试/交叉验证用）。
 * inspect() 对冷会话会合成 closer，两者都是 interrupted 才最可信。
 */
function tailTurnEnd(filePath) {
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
    if (!line || line.trim().length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type === 'turn/end') {
      return {
        kind: String(event?.data?.reason?.kind ?? ''),
        time: Number(event.time ?? 0),
        turn: Number(event?.data?.turn ?? -1),
      }
    }
  }
  return undefined
}

/**
 * updatedAt = max(createdAt, lastPromptAt)，而 lastPromptAt 只统计
 * source.kind==='user' 的 user/message（session-controller list.ts 的
 * applySessionListMetadata / updatedAt），所以它等价于「最后一条人类提示词时间」。
 */
function withinWindow(summary, now, windowMs) {
  const updatedAt = Number(summary?.updatedAt ?? 0)
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false
  return now - updatedAt <= windowMs
}

/** 构造注入文本。刻意不是裸「继续」——重启可能发生在副作用操作中途。 */
function buildPromptText(turn) {
  return [
    '[自动续跑 · 由 dsh 重启触发]',
    '',
    '上一轮（turn ' + turn + '）因 dsh 进程重启被强制中断，没有正常结束。',
    '',
    '请按以下顺序继续：',
    '1. 先核对当前实际状态（工作区文件、git 状态、后台任务/子进程、已执行的外部操作），确认中断前哪些步骤真的完成了；',
    '2. 从中断处继续推进原任务；',
    '3. 不要去重做可能已产生副作用的操作（写文件、提交、推送、删除、发布、部署等）——若无法确认其是否已执行，先核实再决定；',
    '4. 如果核对后仍然无法判断状态，停止操作并向我报告现状与疑点。',
    '',
    '这是一条由插件自动注入的消息，不是新的需求。',
  ].join('\n')
}

/** 可推导 requestId：同会话同轮永远同一 id，借 prompt 自身幂等挡重复注入。 */
function requestIdFor(sessionId, turn) {
  return 'continue-after-interrupted-' + sessionId + '-' + turn
}

async function scanOnce(ctx, config) {
  const now = Date.now()
  const controller = serviceOf(ctx, 'sessionController')
  if (controller === undefined) {
    appendLog('skip: sessionController service unavailable')
    return
  }
  if (typeof controller.list !== 'function' || typeof controller.inspect !== 'function'
    || typeof controller.prompt !== 'function') {
    appendLog('skip: sessionController lacks list/inspect/prompt')
    return
  }

  const signal = new AbortController().signal
  let summaryList = []
  try {
    const listed = await controller.list({}, signal)
    summaryList = Array.isArray(listed?.items) ? listed.items : []
  } catch (error) {
    appendLog('list failed: ' + String(error))
    return
  }

  const ledger = readLedger()
  let candidates = 0
  let resumed = 0
  /** 因静置期未到而被推迟的会话；调用方据此安排下一轮扫描。 */
  const deferred = []

  for (const summary of summaryList) {
    const sessionId = String(summary?.sessionId ?? '')
    if (sessionId.length === 0) continue
    // 子代理会话交给父代理路由，本插件不碰。
    if (summary?.origin === 'subagent' || summary?.parentSessionId !== undefined) continue
    // 空白会话没有可续的内容。
    if (summary?.blank === true) continue
    // 【筛选 1】12h 窗口
    if (!withinWindow(summary, now, config.promptWindowMs)) continue
    // 正在跑的会话不需要续。
    if (summary?.running === true) continue

    candidates++

    let observed
    try {
      observed = await controller.inspect(sessionId)
    } catch (error) {
      appendLog('inspect failed ' + sessionId + ': ' + String(error))
      continue
    }

    const tail = tailTurnEndOf(observed?.events)
    if (tail === undefined) {
      appendLog('skip ' + sessionId + ': no turn/end found')
      continue
    }
    // 【筛选 2】只认 interrupted；'aborted' 是用户主动停止，绝不能续。
    if (tail.kind !== 'interrupted') continue

    // 【筛选 3】静置期：避免与用户刚打开的会话抢 writer。
    // ⚠️ 关键：这里**不能 continue 了事**。重启间隔通常只有几十秒，若 defer 即放弃，
    // 绝大多数真实场景（中断→重启<quietMs）会被永久漏掉。正确做法是把「到期时间」
    // 记下来交给调度器重排，到点再扫一轮。
    const interruptedAt = tail.time > 0 ? tail.time : Number(summary?.updatedAt ?? 0)
    if (interruptedAt > 0 && now - interruptedAt < config.quietMs) {
      const dueAt = interruptedAt + config.quietMs
      deferred.push({ sessionId, dueAt })
      appendLog('defer ' + sessionId + ': interrupted ' + Math.round((now - interruptedAt) / 1000)
        + 's ago (< quietMs ' + Math.round(config.quietMs / 1000) + 's), will retry in '
        + Math.round((dueAt - now) / 1000) + 's')
      continue
    }

    // 【筛选 4】次数上限，防 token 空转。
    const entry = ledger.sessions[sessionId] ?? { attempts: 0, lastTurn: -1, at: 0 }
    if (entry.attempts >= config.maxAttemptsPerSession) {
      appendLog('give up ' + sessionId + ': attempts ' + entry.attempts + ' >= ' + config.maxAttemptsPerSession)
      continue
    }
    if (entry.lastTurn === tail.turn && entry.attempts > 0) {
      appendLog('skip ' + sessionId + ': turn ' + tail.turn + ' already handled')
      continue
    }

    const requestId = requestIdFor(sessionId, tail.turn)

    if (config.dryRun) {
      appendLog('dry-run ' + sessionId + ': would prompt turn ' + tail.turn + ', attempts ' + entry.attempts)
      continue
    }

    // 先记账再发：即使注入途中进程再次崩溃，也不会无限重试。
    ledger.sessions[sessionId] = {
      attempts: entry.attempts + 1,
      lastTurn: tail.turn,
      at: now,
      lastKind: tail.kind,
    }
    writeLedger(ledger)

    try {
      await controller.prompt({
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: buildPromptText(tail.turn) }],
      }, signal)
      resumed++
      appendLog('resumed ' + sessionId + ': turn ' + tail.turn + ', attempt ' + (entry.attempts + 1))
    } catch (error) {
      appendLog('prompt failed ' + sessionId + ': ' + String(error))
    }
  }

  appendLog('scan done: ' + summaryList.length + ' sessions, ' + candidates + ' in window, ' + resumed + ' resumed'
    + (deferred.length > 0 ? ', ' + deferred.length + ' deferred' : ''))
  // 返回下一轮应扫描的时刻；没有待办则 undefined，调度器不必再排。
  if (deferred.length === 0) return undefined
  return Math.min(...deferred.map((d) => d.dueAt))
}

/**
 * @param ctx - cordis 上下文
 * @param config - 用户可覆盖的配置（缺省取 DEFAULTS）
 */
export function apply(ctx, config) {
  const merged = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  if (merged.enabled !== true) {
    appendLog('disabled by config')
    return
  }

  // 扫描调度：启动后第一次 + 被静置期推迟的会话按到期时间重排。
  // ⚠️ 这里必须是**自我重排**而不是「一次扫描 + 结果丢弃」——dsh 重启间隔常只有
  // 几十秒，而静置期是 2 分钟，一次性扫描会让绝大多数真实场景被永久漏过。
  // 所有定时器挂在同一个 effect 里：插件卸载/重启时统一清掉，避免旧实例残留再扫。
  ctx.effect(() => {
    let timer
    let stopped = false
    /** 单轮扫描结束后，按返回的到期时间决定是否再排一轮。 */
    const runScan = async () => {
      if (stopped) return
      let nextDueAt
      try {
        nextDueAt = await scanOnce(ctx, merged)
      } catch (error) {
        appendLog('scan crashed: ' + String(error))
        return
      }
      if (stopped || nextDueAt === undefined) return
      // 至少等 1 秒，避免时钟抖动导致立即重入。
      const delay = Math.max(1000, nextDueAt - Date.now())
      timer = setTimeout(runScan, delay)
      if (typeof timer.unref === 'function') timer.unref()
    }
    timer = setTimeout(runScan, merged.startupDelayMs)
    if (typeof timer.unref === 'function') timer.unref()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, 'interrupted-resume: scan scheduler')

  return {
    scanNow: () => scanOnce(ctx, merged),
    config: merged,
  }
}

export { scanOnce, buildPromptText, requestIdFor, tailTurnEnd, withinWindow, DEFAULTS, stateDir }
