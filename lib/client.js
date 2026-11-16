/**
 * dsh-interrupted-resume — browser half（设置页状态卡，只读）。
 *
 * 注册一个独立的设置 section「中断续跑」，只做一件事：让用户一眼看出
 * 「插件在不在跑、最近续了几次」。⚠️ 刻意不提供任何配置写操作——
 * 配置保持 DEFAULTS（轻量版口径，20261023 用户选定）。
 *
 * 数据来源：GET /api/interrupted-resume/status（host 半注册的只读端点）。
 */

(function () {
  'use strict';

  window.__ModuleLoader__.load({
    id: 'dsh-interrupted-resume',
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

      var React = require('react');
      var h = React.createElement;
      var useState = React.useState;
      var useEffect = React.useEffect;

      var API_BASE = '/api/interrupted-resume';
      var CSS_ID = 'dsh-interrupted-resume-status-styles';
      var NS = 'interrupted-resume';

      // ---- 样式（只用宿主令牌，不设页面级背景；见 postsup-plugin-guide §4.2.1）----
      var CSS_TEXT = [
        '.ir-card { display: flex; flex-direction: column; gap: 16px; }',
        '.ir-row { display: flex; align-items: center; gap: 10px; }',
        '.ir-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }',
        '.ir-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }',
        '.ir-stat { padding: 12px 14px; border-radius: 10px; background: var(--dsw-alias-fill-secondary, rgba(127,127,127,.08)); }',
        '.ir-stat-label { font-size: 12px; opacity: .65; margin-bottom: 4px; }',
        '.ir-stat-value { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }',
        '.ir-log { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6; white-space: pre-wrap; }',
        '.ir-table { width: 100%; border-collapse: collapse; font-size: 13px; }',
        '.ir-table th, .ir-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.15)); }',
      ].join(String.fromCharCode(10));

      function injectStyles() {
        if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')) return;
        var tag = document.createElement('style');
        tag.setAttribute('data-plugin-css', CSS_ID);
        tag.textContent = CSS_TEXT;
        document.head.appendChild(tag);
      }

      function StatusSection(props) {
        var t = (props && typeof props.t === 'function') ? props.t : function (k) { return k; };
        var s0 = useState(null); var data = s0[0], setData = s0[1];
        var s1 = useState(true); var loading = s1[0], setLoading = s1[1];
        var s2 = useState(null); var error = s2[0], setError = s2[1];

        function load() {
          fetch(API_BASE + '/status', { credentials: 'same-origin', cache: 'no-store' })
            .then(function (r) {
              if (!r.ok) throw new Error('HTTP ' + r.status);
              return r.json();
            })
            .then(function (d) { setData(d); setLoading(false); setError(null); })
            .catch(function (e) { setLoading(false); setError(e.message || String(e)); });
        }

        useEffect(function () { load(); }, []);

        if (loading) return h('div', { className: 'ir-card' }, t('loading'));
        if (error) {
          return h('div', { className: 'ir-card' },
            h('div', { className: 'ir-row' },
              h('span', { className: 'ir-dot', style: { background: 'var(--dsw-alias-error, #e5484d)' } }),
              h('span', null, t('loadFailed') + ': ' + error)),
            h('button', { type: 'button', onClick: load }, t('retry')));
        }

        var enabled = !!(data && data.config && data.config.enabled);
        var dryRun = !!(data && data.config && data.config.dryRun);
        var color = !enabled ? 'var(--dsw-alias-label-tertiary, #888)'
          : dryRun ? 'var(--dsw-alias-warning, #f5a623)'
          : 'var(--dsw-alias-success, #30a46c)';
        var statusText = !enabled ? t('statusDisabled') : dryRun ? t('statusDryRun') : t('statusActive');

        return h('div', { className: 'ir-card' },
          h('div', { className: 'ir-row' },
            h('span', { className: 'ir-dot', style: { background: color } }),
            h('strong', null, statusText),
            h('button', { type: 'button', onClick: load, style: { marginLeft: 'auto' } }, t('refresh'))),
          h('div', { className: 'ir-stat-label' }, t('description')),
          h('div', { className: 'ir-grid' },
            stat(h, t('statResumed'), String(data && data.ledgerCount != null ? data.ledgerCount : 0)),
            stat(h, t('statWindow'), fmtDuration(data && data.config && data.config.promptWindowMs)),
            stat(h, t('statQuiet'), fmtDuration(data && data.config && data.config.quietMs)),
            stat(h, t('statMaxAttempts'), String(data && data.config && data.config.maxAttemptsPerSession != null ? data.config.maxAttemptsPerSession : '—'))),
          (function renderLatency() {
            var st = data && data.stats;
            if (!st) return null;
            var cur = st.current || {};
            var sum = st.summary || {};
            var rows = [];
            // 本次启动首跑：最能反映优化效果
            if (cur.firstSendMs != null) {
              rows.push(stat(h, t('statFirstBoot'), fmtDuration(cur.firstSendMs)));
            }
            if (cur.readyMs != null) {
              rows.push(stat(h, t('statReadyMs'), fmtDuration(cur.readyMs)));
            }
            rows.push(stat(h, t('statProbeAttempts'), String(cur.probeAttempts != null ? cur.probeAttempts : 0)));
            rows.push(stat(h, t('statFallback'), cur.fallbackUsed ? t('yes') : t('no')));
            rows.push(stat(h, t('statScanRounds'), String(cur.scanRounds != null ? cur.scanRounds : 0)));
            rows.push(stat(h, t('statDefer'), String(cur.deferCount != null ? cur.deferCount : 0)));
            var summaryRows = sum.count > 0
              ? h('div', { className: 'ir-grid' },
                  stat(h, t('statAvg'), fmtDuration(sum.avgMs)),
                  stat(h, t('statMedian'), fmtDuration(sum.medianMs)),
                  stat(h, t('statP90'), fmtDuration(sum.p90Ms)),
                  stat(h, t('statMax'), fmtDuration(sum.maxMs)))
              : h('div', { className: 'ir-stat-label' }, t('statsEmpty'));
            // 配额区块（20261116）：解释「为什么没续」—— 配额耗尽是最常见原因
            var q = st.quota || {};
            var quotaRows = [
              stat(h, t('qCap'), String(q.cap != null ? q.cap : '—')),
              stat(h, t('qReset'), fmtDuration(q.resetMs)),
              stat(h, t('qMaxUsed'), (q.maxUsed != null ? q.maxUsed : 0) + ' (' + (q.maxPercent || 0) + '%)'),
              stat(h, t('qExhausted'), String(q.exhausted != null ? q.exhausted : 0)),
              stat(h, t('qNearCap'), String(q.nearCap != null ? q.nearCap : 0)),
              stat(h, t('qGiveUp'), String(cur.giveUpCount != null ? cur.giveUpCount : 0)),
              stat(h, t('qResets'), String(cur.resetCount != null ? cur.resetCount : 0)),
            ];
            var quotaTop = (q.top && q.top.length > 0)
              ? h('table', { className: 'ir-table' },
                  h('thead', null, h('tr', null,
                    h('th', null, t('qColSession')),
                    h('th', null, t('qColAttempts')),
                    h('th', null, t('qColPercent')))),
                  h('tbody', null, q.top.map(function (row) {
                    return h('tr', { key: row.sessionId },
                      h('td', { title: row.sessionId }, shortId(row.sessionId)),
                      h('td', null, String(row.attempts)),
                      h('td', { style: row.percent >= 80 ? { color: 'var(--dsw-alias-label-error, #e5484d)', fontWeight: 600 } : null },
                        row.percent + '%'));
                  })))
              : h('div', { className: 'ir-stat-label' }, t('qEmpty'));
            return h('div', { style: { marginTop: 14 } },
              h('div', { className: 'ir-stat-label', style: { marginBottom: 6 } },
                t('statsTitle') + ' ' + t('statsHint')),
              h('div', { className: 'ir-grid' }, rows),
              h('div', { className: 'ir-stat-label', style: { margin: '10px 0 6px' } },
                t('statsRecent') + ' (' + (sum.count || 0) + ')'),
              summaryRows,
              h('div', { className: 'ir-stat-label', style: { margin: '14px 0 6px' } },
                t('quotaTitle')),
              h('div', { className: 'ir-grid' }, quotaRows),
              h('div', { className: 'ir-stat-label', style: { margin: '10px 0 6px' } },
                t('quotaTopTitle')),
              quotaTop);
          })(),
          data && data.ledger && data.ledger.length > 0
            ? h('div', null,
                h('div', { className: 'ir-stat-label', style: { marginBottom: 6 } }, t('ledgerTitle')),
                h('table', { className: 'ir-table' },
                  h('thead', null,
                    h('tr', null, h('th', null, t('colSession')), h('th', null, t('colAttempts')), h('th', null, t('colTurn')), h('th', null, t('colTime')))),
                  h('tbody', null, data.ledger.map(function (row) {
                    return h('tr', { key: row.sessionId },
                      h('td', { title: row.sessionId }, shortId(row.sessionId)),
                      h('td', null, String(row.attempts)),
                      h('td', null, String(row.lastTurn)),
                      h('td', null, fmtTime(row.at)));
                  }))))
            : h('div', { className: 'ir-stat-label' }, t('ledgerEmpty')),
          h('div', null,
            h('div', { className: 'ir-stat-label', style: { marginBottom: 6 } }, t('logTitle')),
            h('pre', { className: 'ir-log', style: { maxHeight: 240, overflow: 'auto', margin: 0, padding: 12, borderRadius: 10, background: 'var(--dsw-alias-fill-secondary, rgba(127,127,127,.08))' } },
              (data && data.recentLog && data.recentLog.length) ? data.recentLog.join(String.fromCharCode(10)) : t('logEmpty'))),
          h('div', { className: 'ir-stat-label' }, t('stateDir') + ': ' + (data && data.stateDir ? data.stateDir : '—')));
      }

      function stat(h, label, value) {
        return h('div', { className: 'ir-stat' },
          h('div', { className: 'ir-stat-label' }, label),
          h('div', { className: 'ir-stat-value' }, value));
      }

      function fmtDuration(ms) {
        if (!ms || typeof ms !== 'number') return '—';
        if (ms >= 3600000) return (Math.round(ms / 360000) / 10) + 'h';
        if (ms >= 1000) return Math.round(ms / 1000) + 's';
        return ms + 'ms';
      }

      function fmtTime(t) {
        if (!t) return '—';
        try { return new Date(t).toLocaleString(); } catch (e) { return '—'; }
      }

      function shortId(id) {
        if (!id) return '—';
        return id.length > 14 ? id.slice(0, 8) + '…' + id.slice(-4) : id;
      }

      var zh = {
        title: '中断续跑',
        description: 'dsh 重启后，自动识别被强制中断的会话并注入一条带状态核对要求的继续指令。以下为只读状态。',
        statusActive: '运行中',
        statusDisabled: '已停用',
        statusDryRun: '试运行（只记录，不注入）',
        refresh: '刷新', retry: '重试', loading: '加载中…',
        loadFailed: '加载失败',
        statResumed: '已续跑会话数',
        statWindow: '候选窗口',
        statQuiet: '静置期',
        statFirstBoot: '首跑延迟(端到端)',
        statReadyMs: '探测就绪耗时',
        statProbeAttempts: '探测次数',
        statFallback: '走了兜底',
        statScanRounds: '本次扫描轮次',
        statDefer: '静置期拦截',
        statAvg: '均值',
        statMedian: '中位',
        statP90: 'P90',
        statMax: '最大',
        statsTitle: '运行统计',
        statsHint: '（重启→发出续跑的端到端延迟）',
        statsRecent: '最近延迟(ms)',
        statsEmpty: '尚无端到端样本',
        quotaTitle: '配额用量（每小时滑动窗口）',
        quotaTopTitle: '用量最高的会话',
        qCap: '每小时上限',
        qReset: '窗口重置',
        qMaxUsed: '单会话最高用时',
        qExhausted: '已耗尽会话',
        qNearCap: '接近上限(≥80%)',
        qGiveUp: '本次放弃次数',
        qResets: '本次重置次数',
        qColSession: '会话',
        qColAttempts: '已用',
        qColPercent: '占比',
        qEmpty: '本窗口内没有续跑记录',
        yes: '是',
        no: '否',
        statMaxAttempts: '每会话上限',
        ledgerTitle: '已处理会话',
        ledgerEmpty: '暂无已处理的会话。',
        logTitle: '最近日志',
        logEmpty: '暂无日志。',
        stateDir: '状态目录',
        colSession: '会话', colAttempts: '次数', colTurn: '轮次', colTime: '时间',
      };
      var en = {
        title: 'Interrupted Resume',
        description: 'After a dsh restart, detects force-interrupted sessions and re-injects a continue prompt that requires state verification first. Read-only status below.',
        statusActive: 'Active',
        statusDisabled: 'Disabled',
        statusDryRun: 'Dry run (log only)',
        refresh: 'Refresh', retry: 'Retry', loading: 'Loading…',
        loadFailed: 'Load failed',
        statResumed: 'Sessions resumed',
        statWindow: 'Candidate window',
        statQuiet: 'Quiet period',
        statFirstBoot: 'First send (end-to-end)',
        statReadyMs: 'Probe ready in',
        statProbeAttempts: 'Probe attempts',
        statFallback: 'Used fallback',
        statScanRounds: 'Scan rounds',
        statDefer: 'Deferred by quiet',
        statAvg: 'Avg',
        statMedian: 'Median',
        statP90: 'P90',
        statMax: 'Max',
        statsTitle: 'Runtime stats',
        statsHint: '(end-to-end: boot → send)',
        statsRecent: 'Recent latencies (ms)',
        statsEmpty: 'No end-to-end samples yet',
        quotaTitle: 'Quota usage (hourly window)',
        quotaTopTitle: 'Top sessions by usage',
        qCap: 'Cap per hour',
        qReset: 'Window reset',
        qMaxUsed: 'Max used (session)',
        qExhausted: 'Exhausted sessions',
        qNearCap: 'Near cap (>=80%)',
        qGiveUp: 'Give-ups (this run)',
        qResets: 'Resets (this run)',
        qColSession: 'Session',
        qColAttempts: 'Used',
        qColPercent: 'Pct',
        qEmpty: 'No resume in this window',
        yes: 'yes',
        no: 'no',
        statMaxAttempts: 'Max per session',
        ledgerTitle: 'Handled sessions',
        ledgerEmpty: 'No sessions handled yet.',
        logTitle: 'Recent log',
        logEmpty: 'No log yet.',
        stateDir: 'State dir',
        colSession: 'Session', colAttempts: 'Attempts', colTurn: 'Turn', colTime: 'Time',
      };

      function apply(ctx) {
        injectStyles();
        if (ctx && ctx.effect) {
          ctx.effect(function () {
            return function () {
              var tag = document.querySelector('style[data-plugin-css="' + CSS_ID + '"]');
              if (tag) tag.remove();
            };
          }, 'dsh-interrupted-resume: ui mount');
        }
        if (ctx && ctx.locale) {
          var off = ctx.locale.register(NS, { zh: zh, en: en });
          if (ctx.effect) ctx.effect(function () { return function () { if (off) off(); }; }, 'dsh-interrupted-resume: locale');
        }
        if (ctx && ctx.slots) {
          ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section', id: 'interrupted-resume', order: 1100,
              label: function () { return ctx.locale.bind(NS)('title'); },
              locale: NS,
            }, StatusSection);
          });
        }
      }

      exports.apply = apply;
      exports.inject = ['slots', 'locale'];
      exports.default = { apply: apply, inject: ['slots', 'locale'] };

      return module.exports;
    },
  });
})();
