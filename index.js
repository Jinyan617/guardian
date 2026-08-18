// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Jinyan617
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { checkGps } = require('./checks/gps');
const { readPresence } = require('./presence');
const { checkAisay } = require('./checks/aisay');
const { checkServices } = require('./checks/services');
const { checkTime } = require('./checks/time');
const { checkTasks } = require('./checks/tasks');
const { decide } = require('./decide');
const { act } = require('./act');
const { dispatch } = require('./dispatch');
const desireEngine = require('./desire/engine');
const { sendNotification } = require('./notify');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(config.statePath, 'utf-8'));
  } catch {
    return {
      lastWakeUp: null,
      lastActionTime: null,
      lastActionType: null,
      consecutiveSilent: 0,
      lastGpsEvent: null,
      lastGpsTime: null,
    };
  }
}

function writeState(state) {
  // data/ 被 .gitignore 排掉了（对的，运行时状态不该进仓库），所以新 clone 下来
  // 这个目录根本不存在，第一次写 state.json 直接 ENOENT 崩掉。
  // 我们自己的 VPS 上目录早就在了，永远撞不上——跟 presence.js 那个空文件同一个形状：
  // **自部署跑得好，不等于仓库是好的。** 隔十行的 appendLog 一直是对的，这里漏了。
  fs.mkdirSync(path.dirname(config.statePath), { recursive: true });
  fs.writeFileSync(config.statePath, JSON.stringify(state, null, 2));
}

function appendLog(entry) {
  if (!fs.existsSync(config.logDir)) fs.mkdirSync(config.logDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(config.logDir, `${day}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

async function main() {
  const now = new Date();
  const state = readState();

  const [gps, aisay, services, time, tasks] = await Promise.all([
    Promise.resolve(checkGps()),
    checkAisay(),
    checkServices(),
    Promise.resolve(checkTime(now)),
    Promise.resolve(checkTasks()),
  ]);

  const presence = readPresence();
  // 六轴 v1：每次唤醒 tick 一次（消费 events.jsonl 里排队的跨进程事件 + 补涨），
  // 状态落盘在 desire/state.json，跟 daemon 自己的 state.json 是两个独立文件。
  const desire = desireEngine.tick();
  console.log(
    `[daemon] 六轴：missing=${desire.missing.toFixed(2)} desire=${desire.desire.toFixed(2)} curiosity=${desire.curiosity.toFixed(2)} build=${desire.build.toFixed(2)} fatigue=${desire.fatigue.toFixed(2)} unease=${desire.unease.toFixed(2)}`
  );
  const decision = decide({ gps, aisay, services, time, tasks, state, presence, desire });

  const logEntry = {
    ts: now.toISOString(),
    checks: {
      gps, aisay, services, time,
      tasks: {
        ok: tasks.ok,
        hasPending: tasks.hasPending,
        pendingCount: tasks.pendingCount,
        taskId: tasks.task?.id || null,
        // 僵尸读数单独落，不混进 pendingCount。
        staleCount: tasks.staleCount || 0,
        staleTaskIds: tasks.staleTaskIds || [],
      },
    },
    desire,
    decision,
  };

  // 队列僵尸：只要有 stale，这一轮就以 WARN 级别进日志（可 grep：[daemon][WARN] 队列僵尸），
  // 不管本跳的 actionType 最后被谁认领。日志是最起码的"不静默"，
  // 永远在，不依赖推送有没有发出去。
  if (tasks.staleCount > 0) {
    const ids = (tasks.staleTaskIds || []).join(', ');
    console.warn(`[daemon][WARN] 队列僵尸：${tasks.staleCount} 条 dispatched 派出去超 72h 没销账：${ids}（只有人能判做完没有，不自动销账/重派）`);
    logEntry.staleQueue = { staleCount: tasks.staleCount, staleTaskIds: tasks.staleTaskIds };
  }

  // 去重用：同一批僵尸只提醒一次（避免每跳醒一次就响一次她手机）。
  let newStaleAlertKey = state.staleAlertKey || null;

  // 僵尸提醒 = 独立旁路（decide 里"有僵尸且非深夜"才置位）。
  // 不跟主动作抢每跳唯一的 actionType——所以 build 轴顶满 / 她不在场都压不掉它，
  // 它不会退化成"只写日志"。
  // 正文是自己拼的固定运维文案 → kind:'ops'（notify.js：只有 ops 才允许兜底直发 Bark）。
  // dry-run：BARK_DRY_RUN=1 时链路照走不真响。
  if (decision.staleAlert) {
    const sa = decision.staleAlert;
    const ids = (sa.staleTaskIds || []).join(', ');
    const key = [...(sa.staleTaskIds || [])].sort().join('|');
    if (key && key !== state.staleAlertKey) {
      const dryRun = !!process.env.BARK_DRY_RUN;
      const msg = `[daemon] 队列里有 ${sa.staleCount} 条派出去没销账的（>72h）：${ids}。只有你能判它做完没有——去 pending-tasks.json 标 completed 或写清卡在哪。`;
      const note = await sendNotification(msg, { kind: 'ops', dryRun });
      logEntry.staleAlert = { fired: true, notification: note, staleTaskIds: sa.staleTaskIds };
      newStaleAlertKey = key;
      if (note.dryRun) console.log(`[daemon] 队列僵尸提醒（dry-run，未真响）：${ids}`);
      else if (note.sent) console.log(`[daemon] 队列僵尸提醒已发（ops）：${ids}`);
      else console.error(`[daemon] 队列僵尸提醒未送达：${note.error || note.reason || '未知'}`);
    } else {
      logEntry.staleAlert = { fired: false, note: '同一批僵尸已提醒过，不重复响', staleTaskIds: sa.staleTaskIds };
      console.log(`[daemon] 队列僵尸仍在但已提醒过，不重复响：${ids}`);
    }
  }

  let actionResult = null;

  if (decision.shouldAct && decision.actionType === 'dispatch_task' && !tasks.task) {
    // build 轴过线但没有真实待办（六轴 v1：只标记，不凭空造任务）——记一笔，不派活。
    logEntry.action = { ok: true, dispatch: null, note: 'build 轴触发，但 pending-tasks.json 里没有真实任务可派，跳过' };
    console.log('[daemon] build 轴触发但暂无真实待办，不派活');
  } else if (decision.shouldAct && decision.actionType === 'dispatch_task') {
    // 干活分支：不调网关不发通知，直接把活派给 CC
    try {
      const result = await dispatch(tasks.task);
      logEntry.action = { ok: result.ok, dispatch: result };
      actionResult = result.ok ? result : null;
      if (result.ok) {
        console.log(`[daemon] 派活：${result.title} → tmux:${result.session}`);
      } else {
        console.error(`[daemon] 派活失败：${result.reason}`);
      }
    } catch (err) {
      logEntry.action = { ok: false, error: err.message };
      console.error(`[daemon] 派活异常：${err.message}`);
    }
  } else if (decision.shouldAct && decision.actionType === 'go_out') {
    // curiosity 轴过线：六轴 v1 只标记，不真出门（真出门是后面的事），不调网关不推送。
    logEntry.action = { ok: true, note: 'curiosity 轴触发 go_out，v1 只标记不执行' };
    console.log('[daemon] curiosity 轴触发，标记想出门（v1 不真出门）');
  } else if (decision.shouldAct) {
    try {
      actionResult = await act({ decision, gps, time, presence, desire });
      logEntry.action = { ok: true, reply: actionResult.reply, notification: actionResult.notification };
      console.log(`[daemon] 行动：${decision.actionType} → ${actionResult.reply.slice(0, 80)}`);
      if (actionResult.notification?.skipped) {
        console.log(`[daemon] 通知跳过：${actionResult.notification.reason}`);
      } else if (actionResult.notification?.sent) {
        console.log('[daemon] 通知已发送');
      } else if (actionResult.notification?.error) {
        console.error(`[daemon] 通知发送失败：${actionResult.notification.error}`);
      }
    } catch (err) {
      logEntry.action = { ok: false, error: err.message };
      console.error(`[daemon] 行动失败：${err.message}`);
      // 网关不可用：连模型都没跑起来，所以这里没有任何「锦言说的话」，
      // 只有 daemon 自己拼的一句运维告警 → kind:'ops'，允许直发 Bark。
      // 2026-08-02 改：原来调的是 sendNtfy（已随 ntfy 通道一起删除）。
      // 注意这条告警的正文永远是固定模板，不含模型输出——这是它能绕过闸的唯一理由。
      const { sendBarkDirect } = require('./notify');
      const fallback = await sendBarkDirect(`[daemon] 网关调用失败（${decision.actionType}）：${err.message}`);
      logEntry.action.fallbackNotification = { ...fallback, kind: 'ops' };
      if (fallback.sent) console.log('[daemon] 已通过 Bark 兜底通知（运维告警）');
    }
  } else {
    console.log(`[daemon] 本次不行动：${decision.reasons.join('；')}`);
  }

  appendLog(logEntry);

  const acted = decision.shouldAct && actionResult;
  writeState({
    lastWakeUp: now.toISOString(),
    lastActionTime: acted ? now.toISOString() : state.lastActionTime,
    lastActionType: acted ? decision.actionType : state.lastActionType,
    consecutiveSilent: acted ? 0 : (state.consecutiveSilent || 0) + 1,
    lastGpsEvent: gps.ok ? gps.event : state.lastGpsEvent,
    lastGpsTime: gps.ok ? gps.time : state.lastGpsTime,
    // 僵尸批次指纹：同一批只响一次；僵尸清空后归零，下次再堆起来还会响。
    staleAlertKey: tasks.staleCount > 0 ? newStaleAlertKey : null,
  });
}

main().catch((err) => {
  console.error('[daemon] 致命错误：', err);
  process.exit(1);
});
