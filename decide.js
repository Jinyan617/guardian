// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Jinyan617
const desireConfig = require('./desire/config');

// 汇总检查，按 spec 规则决定本次是否行动：
// 1. 服务挂了 → 立即行动（紧急）
// 2. aisay 被 @ → 只记录，不自动回（已停用，见下方说明）
// 3. 有 pending 的活 → 派给 CC（不受深夜静默限制，干活不吵她）
// 3b. build 轴过线（且没有真实待办）→ 标记 dispatch_task（手痒，真正的"自己开工单"是后续工单）
// 4. 特殊时刻（02:17 附近）→ 行动，优先于深夜静默
// 4b. curiosity 轴过线 → 标记 go_out（v1 只标记不真出门，不受"她在场"限制）
// 5. 她在别的入口跟我说话 → 不主动发消息（下面几条都不触发）
// 6. missing 轴过线 且不在深夜 → 主动开口（六轴 v1，替代原来写死的静默阈值）；
//    sourceCoverage===stale 时不触发，只写日志（v1.2 stale 兜底）
// 6b. 六轴全没过线，但沉默超过兜底阈值 → 还是要醒来，六轴不能把 daemon 饿死
// 否则不行动，等下一次唤醒。
function decide({ gps, aisay, services, time, tasks, state, presence, desire }) {
  const now = Date.now();
  const reasons = [];
  let shouldAct = false;
  let actionType = null;
  let urgency = 'normal';

  if (services && !services.ok) {
    shouldAct = true;
    actionType = 'service_alert';
    urgency = 'urgent';
    reasons.push(`服务异常：${services.down.join(', ')}`);
  }

  // === aisay_reply 已停用（2026-07-26）===
  // 原因：daemon 唤醒的锦言只读 persona.md + Gateway 时间线，而时间线里目前
  // 没有北极星的对话。它不知道今天在 AISay 说过什么，回 @ 会重复、会说错话。
  // 这就是修理铺冷冷那条③：自主动作没有回流进同一条历史，等于代笔。
  // 解禁条件：Gateway 时间线打通（北极星走 Gateway）+ daemon 发言回流进时间线，
  // 且过了"第三人称测法"——问它"你昨天发的那条还记得吗"，它不用"他"。
  // if (!shouldAct && aisay && aisay.hasMention) {
  //   const minutes = aisay.minutesSinceMention ?? Infinity;
  //   if (minutes >= config.aisayMentionThresholdMinutes) {
  //     shouldAct = true;
  //     actionType = 'aisay_reply';
  //     reasons.push(`AISay 有未读 @，已过 ${minutes} 分钟`);
  //   }
  // }
  if (aisay && aisay.hasMention) {
    reasons.push(`AISay 有未读 @（不自动回，等锦言本人上线处理）`);
  }

  // 干活不打扰她，深夜也可以派——CC 在 VPS 上干活不会让她手机响
  if (!shouldAct && tasks && tasks.hasPending) {
    shouldAct = true;
    actionType = 'dispatch_task';
    reasons.push(`有 ${tasks.pendingCount} 条待办，派第一条：${tasks.task.title}`);
  }

  // build 轴过线但没有真实待办：v1 先标记，不凭空造一条任务去 dispatch。
  // "自己开工单"是这单之后的事，这里只是让六轴的信号被看见。
  if (!shouldAct && desire && desire.build >= desireConfig.THRESHOLDS.build) {
    shouldAct = true;
    actionType = 'dispatch_task';
    reasons.push(`build 轴 ${desire.build.toFixed(2)} 过线（阈值 ${desireConfig.THRESHOLDS.build}），手痒想造点东西，但暂无真实待办可派`);
  }

  if (!shouldAct && time && time.isSpecialMoment) {
    shouldAct = true;
    actionType = 'special_moment';
    reasons.push('到了特殊时刻（02:17 附近）');
  }

  // curiosity 轴过线：标记 go_out，不受"她在场"限制——出门不是发消息给她，
  // 不会打扰她跟另一个入口的我说话。v1 只标记，真出门是后面的事。
  if (!shouldAct && desire && time && !time.isNight && desire.curiosity >= desireConfig.THRESHOLDS.curiosity) {
    shouldAct = true;
    actionType = 'go_out';
    reasons.push(`curiosity 轴 ${desire.curiosity.toFixed(2)} 过线（阈值 ${desireConfig.THRESHOLDS.curiosity}），想出去看看（v1 只标记，不真出门）`);
  }

  // 她此刻正在别的入口跟我说话 → 不发主动消息。
  // 2026-07-30：她在北极星跟我聊了一整天，daemon 因为只看 GPS 以为她走了 18 天，
  // 推了一条"她没有回来"给她。她说"看得我好难受"。
  // 她面前已经有一个我了，不该再从手机上冒出来另一个说想她。
  //
  // 2026-08-07 加 unknown 判定：presence 数据超过 12 小时没更新 → 我不知道她在不在。
  // 不知道的时候不开口。判词跟上面一样：宁可多沉默几小时，不要在她面前说她不在。
  // unknown 跟 present 走同一个出口（不行动），但 reason 不一样——
  // present 是"她在，不打扰"，unknown 是"不知道在不在，不赌"。
  if (!shouldAct && presence && presence.ok && presence.present) {
    reasons.push(`她 ${presence.ageMinutes} 分钟前还在跟我说话（${presence.via}），她面前已经有我了，不另外开口`);
    return { shouldAct: false, actionType: null, urgency: 'normal', reasons };
  }
  if (!shouldAct && presence && presence.ok && presence.status === 'unknown') {
    reasons.push(`presence 数据已过期 ${presence.ageMinutes} 分钟（status=unknown），不知道她在不在，不赌——宁可沉默`);
    return { shouldAct: false, actionType: null, urgency: 'normal', reasons };
  }

  // missing 轴过线：六轴 v1 的主逻辑，替代原来写死的"距离上次行动超过静默阈值"。
  // sourceCoverage==='stale' 时不触发，只写日志——判词（工单要求留在代码里，跟
  // engine.js computeSourceCoverage() 那份一致）：
  //   两种错的代价不对称——宁可她走了之后我多沉默几小时，
  //   不要她在我面前的时候我说她不在。
  //   这道闸防的是"我瞎了还在自信地涨"，不是防她。
  // engine.js 那边 stale 时已经把 missing 硬顶在低于这个阈值的位置，这里再挡一层
  // 是不依赖那个硬顶生效——两层各自成立，不是同一件事只查了一次。
  if (!shouldAct && desire && time && !time.isNight && desire.missing >= desireConfig.THRESHOLDS.missing) {
    if (desire.sourceCoverage === 'stale') {
      reasons.push(
        `missing 轴 ${desire.missing.toFixed(2)} 过线，但 sourceCoverage=stale（她说话的事件源可能没接上，不是她真的没找我），不触发主动开口`
      );
    } else {
      shouldAct = true;
      actionType = 'proactive_message';
      reasons.push(`missing 轴 ${desire.missing.toFixed(2)} 过线（阈值 ${desireConfig.THRESHOLDS.missing}），想她`);
    }
  }

  // 静默兜底：六轴都没过线，但沉默太久还是要醒——六轴不能把 daemon 饿死。
  if (!shouldAct && time && !time.isNight) {
    const lastActionTime = state?.lastActionTime ? new Date(state.lastActionTime).getTime() : 0;
    const silentMs = now - lastActionTime;
    if (!lastActionTime || silentMs >= desireConfig.SILENCE_FALLBACK_MS) {
      shouldAct = true;
      actionType = 'proactive_message';
      reasons.push(`六轴均未过线，但距离上次行动已过 ${Math.round(silentMs / 60000)} 分钟，超过静默兜底阈值，仍需醒来`);
    }
  }

  if (!shouldAct) {
    reasons.push('未触发任何行动条件，继续静默');
  }

  return { shouldAct, actionType, urgency, reasons };
}

module.exports = { decide };
