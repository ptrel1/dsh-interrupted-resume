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
 *   3. 距中断至少静置 5 秒（quietMs，20261116 由 30s 下调），避开用户重启后马上打开该会话造成的 writer 竞争；
 *   4. 每会话最多自动续 2 次（防模型反复中断时 token 空转）；
 *   5. requestId 可推导，借用 prompt 自身的幂等检查做第二层防重。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

/** Stable cordis plugin name. */
export const name = 'interrupted-resume'

/**
 * 必需服务。webServer 用于挂只读状态 API（供设置页状态卡使用）；
 * 它在 web profile 里恒存在，不会导致插件在精简 profile 下被整包跳过。
 * 其余能力（如 sessionController 的其它方法）一律 ctx.get() 现取。
 */
export const inject = ['sessionController', 'webServer']

/** 默认配置：与确认口径一致。 */
const DEFAULTS = {
  promptWindowMs: 12 * 60 * 60 * 1000,
  startupDelayMs: 5 * 1000,
  /**
   * 静置期：距中断至少这么久才续，避开「重启后立刻打开该会话」造成的 writer 竞争。
   * 20261116 由 30s 降到 5s：实测日志中 defer 延迟集中在 10~25s，30s 纯属过保守。
   *   5s 的依据：① 重启到用户手动点开会话，实测至少需 1~3s；
   *              ② 有 requestId 幂等做第二层防重；
   *              ③ 中断时刻来自事件日志，跨进程写入本身有秒级延迟。
   * ⚠️ 不建议再降到 1s：其他客户端（手机端已开页面）可能自动重连写会话。
   */
  quietMs: 5 * 1000,
  /**
   * 滑动窗口内最多自动续几次。
   * 20261024 用户定：窗口 1 小时、上限 30 次（原 6 次）。
   *   演变：2 次（永久累计）→ 6 次（1h 滑动窗口）→ 30 次。
   *   ⚠️ 配额只是防「无限烧 token」的最后一道闸，不是正确性机制。
   *   真正的循环防护是 childHandled（同一子代理只触发一次）——
   *   没有它，配额再大也只是把「6 次快速烧完」变成「30 次稍慢烧完」。
   */
  maxAttemptsPerSession: 30,
  /**
   * 次数滑动窗口：某会话距「上一次自动续跑」超过这么久，就把 attempts 归零。
   * 用 entry.at（上次续跑时刻）计时，而不是中断时刻——避免「刚续完就被重置」。
   */
  attemptResetMs: 60 * 60 * 1000,
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
/* ===== 运行统计（20261116 新增）====
 * 目的：量化「重启 → 发出续跑」的端到端延迟，验证探测式启动是否达标。
 * 存储：写在 ledger.json 的 stats 段，与 sessions 并列，互不干扰。
 * 保留：最近 STATS_KEEP 次；本次启动的实时计数单独存 current。
 */
const STATS_KEEP = 50

function emptyStats() {
  return {
    /** 跨重启保留：最近 N 次的端到端延迟（ms）。 */
    latencies: [],
    /** 本次启动的实时计数，重启时重置。 */
    current: null,
  }
}

function readStats() {
  const ledger = readLedger()
  const raw = ledger.stats
  if (!raw || typeof raw !== 'object') return emptyStats()
  return {
    latencies: Array.isArray(raw.latencies) ? raw.latencies.filter((n) => typeof n === 'number' && n >= 0) : [],
    current: raw.current && typeof raw.current === 'object' ? raw.current : null,
  }
}

function writeStats(stats) {
  const ledger = readLedger()
  ledger.stats = {
    latencies: stats.latencies.slice(-STATS_KEEP),
    current: stats.current,
  }
  writeLedger(ledger)
}

/** 本次启动开始：重置 current。bootAt 由调用方传入（进程内一致）。 */
function beginRun(bootAt) {
  const stats = readStats()
  stats.current = {
    bootAt,
    readyAt: null,
    readyMs: null,
    probeAttempts: 0,
    fallbackUsed: false,
    scanRounds: 0,
    deferCount: 0,
    giveUpCount: 0,
    resumedCount: 0,
    firstSendAt: null,
    firstSendMs: null,
    lastScanAt: null,
  }
  writeStats(stats)
  return stats
}

/** 累计式更新 current 的某个字段。 */
function bumpStat(key, delta = 1) {
  const stats = readStats()
  if (stats.current === null) return
  stats.current[key] = (Number(stats.current[key]) || 0) + delta
  writeStats(stats)
}

/** 设置 current 的绝对字段。 */
function setStat(key, value) {
  const stats = readStats()
  if (stats.current === null) return
  stats.current[key] = value
  writeStats(stats)
}

/** 记录一次续跑的端到端延迟（bootAt → 发送时刻），并写入滚动窗口。 */
function recordLatency(bootAt, sendAt) {
  const stats = readStats()
  const ms = Math.max(0, sendAt - bootAt)
  stats.latencies.push(ms)
  if (stats.current !== null) {
    stats.current.resumedCount = (Number(stats.current.resumedCount) || 0) + 1
    // 首次发送单独记，便于一眼看出「最快一次」
    if (stats.current.firstSendAt === null) {
      stats.current.firstSendAt = sendAt
      stats.current.firstSendMs = ms
    }
  }
  writeStats(stats)
  return ms
}

/** 聚合：均值 / 中位 / P90 / 最大最小。 */
function summarize(latencies) {
  if (!Array.isArray(latencies) || latencies.length === 0) {
    return { count: 0, avgMs: null, medianMs: null, p90Ms: null, minMs: null, maxMs: null }
  }
  const arr = latencies.slice().sort((a, b) => a - b)
  const sum = arr.reduce((acc, n) => acc + n, 0)
  const pick = (q) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))]
  return {
    count: arr.length,
    avgMs: Math.round(sum / arr.length),
    medianMs: pick(0.5),
    p90Ms: pick(0.9),
    minMs: arr[0],
    maxMs: arr[arr.length - 1],
  }
}

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

/**
 * 可推导 requestId：同会话同轮**同来源**永远同一 id，借 prompt 自身幂等挡重复注入。
 * @param sessionId - 目标会话
 * @param turn - 判据所用的轮次
 * @param cause - 中断来源：'self'（自身被重启打断）或 'child'（子代理被打断，父代理被唤醒）。
 *   必须区分：父会话可能在 turn N 因自身中断被续过一次，之后又在同一 turn N
 *   因「子代理被打断」需要再醒一次；若不加 cause 会拿到同一 requestId 被幂等拒绝。
 */
function requestIdFor(sessionId, turn, cause) {
  const suffix = cause === 'child' ? '-child' : ''
  return 'continue-after-interrupted-' + sessionId + '-' + turn + suffix
}

async function scanOnce(ctx, config, prefetched, bootAt) {
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
  if (Array.isArray(prefetched)) {
    // 探测阶段已 list 过一次，直接复用，避免 334 个会话读两遍（20261116）
    summaryList = prefetched
  } else {
    try {
      const listed = await controller.list({}, signal)
      summaryList = Array.isArray(listed?.items) ? listed.items : []
    } catch (error) {
      appendLog('list failed: ' + String(error))
      return
    }
  }

  const ledger = readLedger()
  let candidates = 0
  let resumed = 0
  /** 因静置期未到而被推迟的会话；调用方据此安排下一轮扫描。 */
  const deferred = []

  /**
   * ⭐ 子代理缺口修复（20261023 实测发现）：
   * 父代理「派完子代理、等待结果」时，它自己的 turn 会以 **completed** 正常结束，
   * 而子代理的 turn 是 **open**（被重启打断）。此时：
   *   - 父会话：最后 turn/end = completed ⇒ 按原规则不续；
   *   - 子会话：origin=subagent ⇒ 被过滤。
   * ⇒ **整棵子树静默死掉，什么都不会发生。**
   *
   * 修法：先按 parentSessionId 聚合出「哪些父会话有未闭合的子代理」，
   * 这些父会话即使自身是 completed 也纳入候选——由父代理醒来自行核对/重派。
   * 父代理是唯一知道「我派了什么」的实体，让它醒来比我们猜更可靠。
   */
  const parentsWithOpenChild = new Set()
  /** 父会话 id → 其被打断子代理的最晚中断时刻（ms）。 */
  const childInterruptedAt = new Map()

  /**
   * ⚠️ 预扫描必须**收窄范围**（20261023 实踩）：
   * 初版对列表里**所有** parentSessionId 非空的会话调 inspect()，在 dsh1 上
   * 每轮要多 inspect 数百个历史子代理，其中 8 个老格式会话必然抛
   * 「unsupported descriptor version 2」⇒ 单轮扫描从秒级涨到 **17 秒**，
   * 且日志被完整堆栈刷屏（16 条/两轮），把真正的判定记录淹掉。
   *
   * 收窄为两条同时满足才 inspect：
   *   ① 子代理自己在 12h 窗口内（updatedAt）——更老的子代理不可能拖住刚被打断的父会话；
   *   ② 它的父会话本身也在窗口内（非空白）。
   * 另外失败的子会话记进 ledger.unsupported，**永久跳过**，不每轮重试。
   */
  const unsupported = ledger.unsupported ?? {}
  /**
   * ⭐ 已处理过的中断子代理（20261024 修复）。
   *
   * 为什么必须有它：子代理被打断后会**永久停在 interrupted**（它不会自己恢复，
   * 父代理重派也只是新建一个，老的仍留着）。若每轮都把它算作「父会话有待办」，
   * 父会话就会被**无限唤醒**：实测 e71e4069 连续 4 分钟触发了 4 次续跑
   * （attempt 3→4→5→6），几分钟就把配额烧光，而根因只是同一个僵尸子代理。
   *
   * 语义：childHandled[childId] = true 表示「这个子代理的中断已通知过父会话」。
   * 之后无论扫描多少轮都跳过它。新产生的子代理不受影响。
   */
  const childHandled = ledger.childHandled ?? {}
  /** 父会话 id → 本轮触发它的中断子代理 id 列表（用于续跑成功后打标）。 */
  const childrenByParent = new Map()
  /** 本轮的失败计数：只写一行摘要，不逐条堆栈。 */
  let childInspectFailed = 0
  for (const summary of summaryList) {
    const parentId = summary?.parentSessionId
    if (parentId === undefined || parentId === null) continue
    // 20261116：只对「真子代理」做父会话聚合。
    // 分叉会话也有 parentSessionId（记录 fork 来源），但它不是被委派的子代理，
    // 把它当子代理 inspect 一遍既浪费开销、又会让日志出现误导性的 note。
    if (summary?.origin !== 'subagent') continue
    // 子代理自身能不能续跑不归我们管，只关心「它是否把父会话拖住了」。
    // ⚠️ 判据必须是「子代理仍有 open turn」，不是「存在子代理」。
    const childId = String(summary?.sessionId ?? '')
    if (childId.length === 0) continue
    // ① 已知无法解析的老格式会话：永久跳过。
    if (unsupported[childId] === true) continue
    // ② ⭐ 用日志 mtime 预筛（20261023 二次修正）。
    //    不能用 list() 的 updatedAt 筛：它 = max(createdAt, lastPromptAt)，而子代理
    //    通常只在启动时收一次提示、之后长时间运行 ⇒ lastPromptAt 恒为很久以前，
    //    窗口判定形同虚设（实测 8 个老格式会话仍被 inspect，单轮扫描拖到 17 秒）。
    //    mtime 反映「日志最后被追加的时刻」，才是「这个子代理最近是否真的在动」。
    const childMtime = sessionLogMtimeMs(childId)
    if (childMtime === 0) continue // 找不到日志 ⇒ 无从判断，跳过
    if (now - childMtime > config.promptWindowMs) continue
    try {
      const child = await controller.inspect(childId)
      const childTail = tailTurnEndOf(child?.events)
      // 子代理最后一轮仍 open（inspect 会补一条 interrupted 的合成 closer）
      if (childTail !== undefined && childTail.kind === 'interrupted') {
        // ⭐ 已通知过父会话的子代理不再重复触发（防僵尸子代理导致无限唤醒）。
        if (childHandled[childId] === true) continue
        parentsWithOpenChild.add(String(parentId))
        // 记下「是哪些子代理把父会话拖住了」，续跑成功后要把它们标记为已处理。
        const bucket = childrenByParent.get(String(parentId))
        if (bucket === undefined) childrenByParent.set(String(parentId), [childId])
        else bucket.push(childId)
        // 记录子代理中断时刻：父会话自身的 turn 可能早在等待前就 completed 了，
        // 用它算静置期才准确。
        const prev = childInterruptedAt.get(String(parentId)) ?? 0
        childInterruptedAt.set(String(parentId), Math.max(prev, childTail.time || 0))
        appendLog('note: ' + String(parentId) + ' has interrupted child ' + childId + ' (turn ' + childTail.turn + ')')
      }
    } catch (error) {
      // ⚠️ 不逐条写堆栈：失败会话记进 ledger.unsupported 永久跳过，
      //    本轮只累加计数，在扫描结束时写一行摘要（否则日志会被刷屏）。
      childInspectFailed++
      unsupported[childId] = true
    }
  }
  if (childInspectFailed > 0) {
    ledger.unsupported = unsupported
    writeLedger(ledger)
    appendLog('note: ' + childInspectFailed + ' child session(s) unreadable, marked unsupported (skipped forever)')
  }

  for (const summary of summaryList) {
    const sessionId = String(summary?.sessionId ?? '')
    if (sessionId.length === 0) continue
    // 【筛选 0】子代理会话交给父代理路由，本插件不碰。
    // 20261116 修正：原判据是 `origin === 'subagent' || parentSessionId !== undefined`，
    //   把「分叉会话」一并滤掉了。
    //   依据 dsh-session/lib/index.js:1053 —— header.origin 的合法值只有 'subagent'，
    //   普通会话**根本不带该字段**；分叉会话带的是 parentSession（记录 fork 来源）。
    //   ⇒ parentSessionId 非空 ≠ 子代理，原判据把「从别的会话 fork 出来」的会话
    //     当成子代理永久跳过，ledger 里连记录都不会有。
    //   现判据只看 origin：缺失 = 不是子代理 = 应正常参与续跑判定。
    if (summary?.origin === 'subagent') continue
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
    // 【筛选 2】两种情形可续：
    //   a) 自身最后 turn = interrupted（自身被重启打断）
    //   b) 自身 completed，但**有被打断的子代理**（父代理在等子代理结果时被重启，
    //      见上方 parentsWithOpenChild 的说明）。此时续父代理，由它核对/重派。
    // 'aborted' 是用户主动停止，任何情形下都绝不能续。
    const hasOpenChild = parentsWithOpenChild.has(sessionId)
    if (tail.kind !== 'interrupted' && !hasOpenChild) continue
    if (tail.kind !== 'interrupted' && hasOpenChild) {
      appendLog('resume-by-child ' + sessionId + ': parent turn ' + tail.turn + ' completed but has interrupted subagent')
    }

    // 【筛选 3】静置期：避免与用户刚打开的会话抢 writer。
    // ⚠️ 关键：这里**不能 continue 了事**。重启间隔通常只有几十秒，若 defer 即放弃，
    // 绝大多数真实场景（中断→重启<quietMs）会被永久漏掉。正确做法是把「到期时间」
    // 记下来交给调度器重排，到点再扫一轮。
    const ownAt = tail.kind === 'interrupted' && tail.time > 0 ? tail.time : 0
    const childAt = childInterruptedAt.get(sessionId) ?? 0
    let interruptedAt = Math.max(ownAt, childAt)
    if (interruptedAt === 0) interruptedAt = Number(summary?.updatedAt ?? 0)
    if (interruptedAt > 0 && now - interruptedAt < config.quietMs) {
      const dueAt = interruptedAt + config.quietMs
      deferred.push({ sessionId, dueAt })
      appendLog('defer ' + sessionId + ': interrupted ' + Math.round((now - interruptedAt) / 1000)
        + 's ago (< quietMs ' + Math.round(config.quietMs / 1000) + 's), will retry in '
        + Math.round((dueAt - now) / 1000) + 's')
      continue
    }

    // 中断来源：'self' = 自身被重启打断；'child' = 子代理被打断，父代理需被唤醒。
    const cause = tail.kind === 'interrupted' ? 'self' : 'child'

    // 【筛选 4】次数上限，防 token 空转。
    let entry = ledger.sessions[sessionId] ?? { attempts: 0, lastTurn: -1, at: 0 }
    // ⭐ 次数按「滑动窗口」计：距上次续跑超过 attemptResetMs（默认 1 小时）就归零。
    // 不重置的话，长会话会被历史次数永久吃掉配额（实测同一天第 3 次中断就不再续）。
    // 用 entry.at（上一次续跑的时刻）而非中断时刻，避免"刚续完又被重置"。
    if (entry.attempts > 0 && entry.at > 0 && now - entry.at > config.attemptResetMs) {
      appendLog('reset ' + sessionId + ': attempts ' + entry.attempts + ' -> 0 (idle '
        + Math.round((now - entry.at) / 60000) + 'min > ' + Math.round(config.attemptResetMs / 60000) + 'min)')
      entry = { attempts: 0, lastTurn: -1, at: 0, resetFrom: entry.attempts }
      ledger.sessions[sessionId] = entry
      writeLedger(ledger)
    }
    if (entry.attempts >= config.maxAttemptsPerSession) {
      appendLog('give up ' + sessionId + ': attempts ' + entry.attempts + ' >= ' + config.maxAttemptsPerSession)
      continue
    }
    // 同一 (turn, cause) 已处理过就不再重复。⚠️ 必须带上 cause：
    // 父会话可能在同一 turn 上先后经历 self（自身打断）与 child（子代理打断），
    // 只比 turn 会把后者误判为「已处理」而漏掉。
    if (entry.lastTurn === tail.turn && (entry.lastCause ?? 'self') === cause && entry.attempts > 0) {
      appendLog('skip ' + sessionId + ': turn ' + tail.turn + ' (' + cause + ') already handled')
      continue
    }
    const requestId = requestIdFor(sessionId, tail.turn, cause)

    if (config.dryRun) {
      appendLog('dry-run ' + sessionId + ': would prompt turn ' + tail.turn + ', attempts ' + entry.attempts)
      continue
    }

    // 先记账再发：即使注入途中进程再次崩溃，也不会无限重试。
    ledger.sessions[sessionId] = {
      attempts: entry.attempts + 1,
      lastTurn: tail.turn,
      lastCause: cause,
      at: now,
      lastKind: tail.kind,
    }
    // ⭐ 若是被中断子代理触发的，把它们一并标记为已处理——
    // 否则这些子代理永远停在 interrupted 状态，下一轮扫描又会把父会话叫醒。
    const triggeringChildren = childrenByParent.get(sessionId) ?? []
    for (const cid of triggeringChildren) childHandled[cid] = true
    if (triggeringChildren.length > 0) {
      ledger.childHandled = childHandled
      appendLog('mark children handled for ' + sessionId + ': ' + triggeringChildren.join(','))
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
      // 端到端延迟：本次启动 → 此刻发出续跑
      if (typeof bootAt === 'number' && bootAt > 0) recordLatency(bootAt, Date.now())
      appendLog('resumed ' + sessionId + ': turn ' + tail.turn + ', attempt ' + (entry.attempts + 1))
    } catch (error) {
      appendLog('prompt failed ' + sessionId + ': ' + String(error))
    }
  }

  // 统计：扫描轮次 / 静置期拦截次数 / 最后扫描时刻
  bumpStat('scanRounds')
  if (deferred.length > 0) bumpStat('deferCount', deferred.length)
  setStat('lastScanAt', Date.now())
  appendLog('scan done: ' + summaryList.length + ' sessions, ' + candidates + ' in window, ' + resumed + ' resumed'
    + (deferred.length > 0 ? ', ' + deferred.length + ' deferred' : ''))
  // 返回下一轮应扫描的时刻；没有待办则 undefined，调度器不必再排。
  if (deferred.length === 0) return undefined
  return Math.min(...deferred.map((d) => d.dueAt))
}

/** 会话日志文件名候选，按新→旧排列（v4 优先，回退到 v3 / 旧格式）。 */
const LOG_FILE_CANDIDATES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']

/** 会话日志所在根目录（跟随 DSH_HOME）。 */
function sessionsRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/**
 * 在 <sessions>/<workspace>/<sessionId>/ 下找到实际的日志文件。
 * ⚠️ 不缓存目录列表：会话随时新增，缓存会漏掉刚建的那个。
 * @param sessionId - 会话 id（父会话形如 session-<uuid>，子代理是裸 uuid）
 * @returns 日志绝对路径；找不到返回 undefined
 */
function findSessionLog(sessionId) {
  if (!sessionId) return undefined
  const root = sessionsRoot()
  let workspaces
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    const dir = join(root, ws.name, sessionId)
    for (const name of LOG_FILE_CANDIDATES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * 会话日志的最后写入时刻（ms）。子代理运行期间日志持续追加，
 * 所以 mtime 比 list() 的 updatedAt 更能反映「最近是否真的在动」。
 * @param sessionId - 目标会话
 * @returns mtime 毫秒；找不到或不可读时返回 0（调用方据此保守处理）
 */
function sessionLogMtimeMs(sessionId) {
  const file = findSessionLog(sessionId)
  if (file === undefined) return 0
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** 只读状态 API 路径。设置页状态卡读它。 */
/** 可能导致启动失败的会话判据（全部命中才算危险）。
 *
 * 源自一次真实故障（20261024）：dsh 启动恢复会话时抛
 *   fatal load failure: agent "..." cannot read inbox state:
 *   its projection registration is not active
 * 触发者是 agent-loop 的 `current()`——它读 inbox 的 projection 状态，读到 undefined 就 throw。
 * 实测命中的会话特征：旧格式（v3/legacy）+ 有 agent/inbox/spliced 事件 + 最后一条是
 * 「canceled 且 inserted 为空」的 splice。全库 517 个会话只有 2 个命中。
 */
const LOG_FILE_CANDIDATES_FOR_SCAN = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']

/**
 * 判断一个会话是否命中「会导致启动失败」的判据。
 * @param filePath - 会话日志路径
 * @returns undefined 表示安全；否则返回判定依据
 */
function riskySessionReason(filePath) {
  const fmt = basename(filePath)
  // v4 是当前格式，不处理。
  if (fmt === 'session.v4.jsonl.zstd') return undefined
  let lines
  try {
    lines = zstdDecompressSync(readFileSync(filePath)).toString('utf8').split('\n').filter(Boolean)
  } catch {
    return undefined
  }
  if (lines.length < 2) return undefined
  let events
  try {
    events = lines.slice(1).map((l) => JSON.parse(l))
  } catch {
    return undefined
  }
  const splices = events.filter((e) => e?.type === 'agent/inbox/spliced')
  if (splices.length === 0) return undefined
  const last = events[events.length - 1]
  const isCanceledTail = last?.type === 'agent/inbox/spliced'
    && last?.data?.outcome === 'canceled'
    && Array.isArray(last?.data?.inserted)
    && last.data.inserted.length === 0
  if (!isCanceledTail) return undefined
  let header = {}
  try { header = JSON.parse(lines[0]) } catch { /* header 解析失败不影响判定 */ }
  return {
    format: fmt,
    origin: header?.origin ?? 'main',
    createdAt: Number(header?.createdAt ?? 0),
    splicedCount: splices.length,
  }
}

/**
 * 扫描全部会话，列出命中「会导致启动失败」判据的会话。只读，不改任何文件。
 * @returns 危险会话列表
 */
function scanRiskySessions() {
  const root = sessionsRoot()
  const out = []
  let workspaces
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    let entries
    try { entries = readdirSync(join(root, ws.name), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const dir = join(root, ws.name, e.name)
      const file = LOG_FILE_CANDIDATES_FOR_SCAN.map((n) => join(dir, n)).find((p) => existsSync(p))
      if (file === undefined) continue
      const reason = riskySessionReason(file)
      if (reason === undefined) continue
      out.push({ sessionId: e.name, workspace: ws.name, dir, ...reason })
    }
  }
  out.sort((a, b) => a.createdAt - b.createdAt)
  return out
}
/** 归档目标目录：与 DSH_HOME 同级，保持在数据目录内便于一起备份。 */
function archiveRoot() {
  return join(stateDir(), 'archived-sessions')
}

/**
 * 归档一个「会导致启动失败」的会话。**只归档，不删除**。
 *
 * 两级策略（20261024 实测决定）：
 *   ① 注册表知道的会话 → workspaceRegistry.archiveSession()，这是官方路径，
 *      归档后它会从会话列表消失但数据保留；
 *   ② 注册表不知道的（典型是裸 UUID 子代理）→ 那个 API 会抛 session/not-found，
 *      改为把整个会话目录移动到 archived-sessions/ 下。
 *
 * @param ctx - cordis 上下文（用于现取 workspaceRegistry）
 * @param item - scanRiskySessions() 返回的一项
 * @returns { ok, method, error? }
 */
async function archiveRiskySession(ctx, item) {
  const registry = serviceOf(ctx, 'workspaceRegistry')
  // ① 先试官方归档 API
  if (registry !== undefined && typeof registry.archiveSession === 'function') {
    try {
      await registry.archiveSession(item.sessionId, {})
      return { ok: true, method: 'registry' }
    } catch (error) {
      // 注册表不认识这个会话（子代理）→ 落到②；其它错误要如实上报。
      const msg = String(error)
      if (!/not-found|unknown/i.test(msg)) return { ok: false, method: 'registry', error: msg }
    }
  }
  // ② 目录移动
  try {
    const target = join(archiveRoot(), item.workspace, item.sessionId)
    mkdirSync(dirname(target), { recursive: true })
    if (existsSync(target)) return { ok: false, method: 'move', error: 'target already exists' }
    renameSync(item.dir, target)
    return { ok: true, method: 'move' }
  } catch (error) {
    return { ok: false, method: 'move', error: String(error) }
  }
}
const STATUS_API_PATH = '/api/interrupted-resume/status'
/** 不兼容会话列表（只读）。 */
const RISKY_API_PATH = '/api/interrupted-resume/risky'
/** 归档不兼容会话（写操作，需前端二次确认后调用）。 */
const ARCHIVE_API_PATH = '/api/interrupted-resume/archive'

/** 从日志尾部提取最近若干条判定记录（供状态卡展示）。 */
function recentLogLines(limit) {
  const p = logPath()
  if (!existsSync(p)) return []
  try {
    const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().length > 0)
    return lines.slice(-limit)
  } catch {
    return []
  }
}

/**
 * 汇总当前状态。全部只读，不触发扫描、不改配置。
 * @param config - 生效中的配置快照
 * @returns 状态对象：配置快照 + 账本摘要 + 最近日志
 */
function buildStatus(config) {
  const ledger = readLedger()
  const sessions = Object.entries(ledger.sessions ?? {}).map(([sessionId, v]) => ({
    sessionId,
    attempts: Number(v?.attempts ?? 0),
    lastTurn: Number(v?.lastTurn ?? -1),
    at: Number(v?.at ?? 0),
  }))
  sessions.sort((a, b) => b.at - a.at)
  return {
    ok: true,
    config: {
      enabled: config.enabled === true,
      dryRun: config.dryRun === true,
      promptWindowMs: config.promptWindowMs,
      startupDelayMs: config.startupDelayMs,
      quietMs: config.quietMs,
      maxAttemptsPerSession: config.maxAttemptsPerSession,
      attemptResetMs: config.attemptResetMs,
    },
    stateDir: stateDir(),
    hasLog: existsSync(logPath()),
    ledgerCount: sessions.length,
    ledger: sessions.slice(0, 20),
    recentLog: recentLogLines(20),
    /* 运行统计（20261116）：量化「重启 → 发出续跑」的端到端延迟。
     * current = 本次启动的实时计数；summary = 最近 50 次的聚合。 */
    stats: (() => {
      const st = readStats()
      return {
        current: st.current,
        summary: summarize(st.latencies),
        recent: st.latencies.slice(-10),
      }
    })(),
  }
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

  // 本次启动时刻：端到端延迟的起点。进程内固定，不随配置变化。
  const bootAt = Date.now()
  beginRun(bootAt)

  // 扫描调度：启动后第一次 + 被静置期推迟的会话按到期时间重排。
  // ⚠️ 这里必须是**自我重排**而不是「一次扫描 + 结果丢弃」——dsh 重启间隔常只有
  // 几十秒，可能与安静置期相当甚至更短，一次性扫描会让真实场景被永久漏过。
  // 所有定时器挂在同一个 effect 里：插件卸载/重启时统一清掉，避免旧实例残留再扫。
  ctx.effect(() => {
    let timer
    let probeTimer = null
    let stopped = false
    /** 首轮扫描是否已发生（探测层与原兜底层共用，防重复）。 */
    let firstScanStarted = false

    /** 单轮扫描结束后，按返回的到期时间决定是否再排一轮。 */
    const runScan = async (prefetched) => {
      if (stopped) return
      firstScanStarted = true
      let nextDueAt
      try {
        nextDueAt = await scanOnce(ctx, merged, prefetched, bootAt)
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

    /* ⭐ 自动识别层（20261116）
     * 目的：宿主就绪后立即开扫，不必固定等 startupDelayMs(=5s)。
     * 判据用「试跑一次 list()」而非只看服务存在 —— 服务在、数据没就绪时
     * 抢跑会扫到空列表然后误判为「无候选」而结束。
     * 预取的 list 结果直接传给 scanOnce，避免 334 个会话读两遍。
     *
     * ⚠️ 原 startupDelayMs 兜底**完全保留**：探测超时或失败时由它接手，
     *    行为与改造前一致。两层用 firstScanStarted 互斥，不会重复扫描。
     */
    const PROBE_INTERVAL_MS = 300
    const PROBE_MAX_ATTEMPTS = 50          // 300ms × 50 = 15s 后放弃探测
    let probeAttempts = 0
    const probeReady = async () => {
      if (stopped || firstScanStarted) return
      probeAttempts++
      const controller = serviceOf(ctx, 'sessionController')
      if (controller !== undefined && typeof controller.list === 'function') {
        try {
          const listed = await controller.list({}, new AbortController().signal)
          const items = Array.isArray(listed?.items) ? listed.items : null
          if (items !== null) {
            if (stopped || firstScanStarted) return
            setStat('probeAttempts', probeAttempts)
            setStat('readyAt', Date.now())
            setStat('readyMs', Date.now() - bootAt)
            setStat('fallbackUsed', false)
            appendLog('ready after ~' + (probeAttempts * PROBE_INTERVAL_MS) + 'ms, scanning now')
            clearTimeout(timer)          // 取消兜底定时器，避免双跑
            timer = undefined
            await runScan(items)
            return
          }
        } catch (error) {
          // 数据未就绪，继续探
        }
      }
      if (probeAttempts >= PROBE_MAX_ATTEMPTS) {
        setStat('fallbackUsed', true)
        setStat('probeAttempts', probeAttempts)
        appendLog('probe timeout after ' + PROBE_MAX_ATTEMPTS + ' attempts, falling back to startupDelayMs')
        return
      }
      probeTimer = setTimeout(() => { void probeReady() }, PROBE_INTERVAL_MS)
      if (typeof probeTimer.unref === 'function') probeTimer.unref()
    }

    // 启动即探（不等 startupDelayMs）
    void probeReady()

    // 原兜底：探测失败/超时由它接手，行为与改造前一致
    timer = setTimeout(() => { void runScan() }, merged.startupDelayMs)
    if (typeof timer.unref === 'function') timer.unref()

    return () => {
      stopped = true
      clearTimeout(timer)
      if (probeTimer !== null) clearTimeout(probeTimer)
    }
  }, 'interrupted-resume: scan scheduler')

  // 只读状态 API：供设置页状态卡显示「它在不在跑」。刻意不提供任何写操作——
  // 配置走 DEFAULTS，不接受页面修改（轻量版口径，20261023 用户选定）。
  ctx.effect(() => {
    const server = serviceOf(ctx, 'webServer')
    if (server === undefined || typeof server.register !== 'function') return
    const handler = async (req, res) => {
      try {
        if ((req.method || 'GET').toUpperCase() !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'read-only endpoint' }))
          return
        }
        const payload = buildStatus(merged)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(payload))
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: String(error) }))
      }
    }
    const route = { kind: 'exact', path: STATUS_API_PATH, handler }
    return server.register(route)
  }, 'interrupted-resume: status API')

  // 不兼容会话的「列出 + 归档」API（20261024 新增，用户要求：不自动，手动触发）。
  //   GET  /api/interrupted-resume/risky   → 只读扫描，返回命中判据的会话
  //   POST /api/interrupted-resume/archive → 归档指定的会话（只归档，不删除）
  ctx.effect(() => {
    const server = serviceOf(ctx, 'webServer')
    if (server === undefined || typeof server.register !== 'function') return
    const disposers = []

    const listHandler = async (req, res) => {
      const reply = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      try {
        if ((req.method || 'GET').toUpperCase() !== 'GET') return reply(405, { ok: false, error: 'use GET' })
        const items = scanRiskySessions()
        reply(200, { ok: true, items, archiveRoot: archiveRoot() })
      } catch (error) {
        reply(500, { ok: false, error: String(error) })
      }
    }

    const archiveHandler = async (req, res) => {
      const reply = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      try {
        if ((req.method || 'GET').toUpperCase() !== 'POST') return reply(405, { ok: false, error: 'use POST' })
        // 读 body（限 64KB，防滥用）
        const raw = await new Promise((resolve, reject) => {
          let size = 0
          const chunks = []
          req.on('data', (c) => {
            size += c.length
            if (size > 65536) { reject(new Error('body too large')); req.destroy(); return }
            chunks.push(c)
          })
          req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          req.on('error', reject)
        })
        let ids = []
        if (raw.trim().length > 0) {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed?.sessionIds)) ids = parsed.sessionIds.map(String)
        }
        // 不传 ids ⇒ 归档全部命中判据的会话（前端会先让用户确认）
        const all = scanRiskySessions()
        const targets = ids.length === 0 ? all : all.filter((x) => ids.includes(x.sessionId))
        const results = []
        for (const item of targets) {
          const r = await archiveRiskySession(ctx, item)
          results.push({ sessionId: item.sessionId, workspace: item.workspace, ...r })
          appendLog('archive ' + item.sessionId + ': ' + (r.ok ? 'ok via ' + r.method : 'FAILED ' + r.error))
        }
        reply(200, { ok: true, archived: results.filter((r) => r.ok).length, results })
      } catch (error) {
        reply(500, { ok: false, error: String(error) })
      }
    }

    disposers.push(server.register({ kind: 'exact', path: RISKY_API_PATH, handler: listHandler }))
    disposers.push(server.register({ kind: 'exact', path: ARCHIVE_API_PATH, handler: archiveHandler }))
    return () => { for (const d of disposers) { if (typeof d === 'function') d() } }
  }, 'interrupted-resume: risky session API')

  return {
    scanNow: () => scanOnce(ctx, merged),
    config: merged,
  }
}

export { scanOnce, buildPromptText, requestIdFor, tailTurnEnd, withinWindow, DEFAULTS, stateDir, buildStatus, STATUS_API_PATH, findSessionLog, sessionLogMtimeMs, scanRiskySessions, riskySessionReason, archiveRoot, RISKY_API_PATH, ARCHIVE_API_PATH }
