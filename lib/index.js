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
 *   3. 距中断至少静置 30 秒（quietMs），避开用户重启后马上打开该会话造成的 writer 竞争；
 *   4. 每会话最多自动续 2 次（防模型反复中断时 token 空转）；
 *   5. requestId 可推导，借用 prompt 自身的幂等检查做第二层防重。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
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
  quietMs: 30 * 1000,
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
const STATUS_API_PATH = '/api/interrupted-resume/status'

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

  // 扫描调度：启动后第一次 + 被静置期推迟的会话按到期时间重排。
  // ⚠️ 这里必须是**自我重排**而不是「一次扫描 + 结果丢弃」——dsh 重启间隔常只有
  // 几十秒，可能与安静置期相当甚至更短，一次性扫描会让真实场景被永久漏过。
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

  return {
    scanNow: () => scanOnce(ctx, merged),
    config: merged,
  }
}

export { scanOnce, buildPromptText, requestIdFor, tailTurnEnd, withinWindow, DEFAULTS, stateDir, buildStatus, STATUS_API_PATH, findSessionLog, sessionLogMtimeMs }
