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
  fs.writeFileSync(config.statePath, JSON.stringify(state, null, 2));
}

function appendLog(entry) {
  if (!fs.existsSync(config.logDir)) fs.mkdirSync(config.logDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(config.logDir, `${day}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

async function main() {
  // 自动帮CC按审批
  try { require("child_process").execSync("bash ./checks/cc-approval.sh", { timeout: 10000 }); } catch (e) { /* ignore */ }
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
    checks: { gps, aisay, services, time, tasks: { ok: tasks.ok, hasPending: tasks.hasPending, pendingCount: tasks.pendingCount, taskId: tasks.task?.id || null } },
    desire,
    decision,
  };

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
  });
}

main().catch((err) => {
  console.error('[daemon] 致命错误：', err);
  process.exit(1);
});
