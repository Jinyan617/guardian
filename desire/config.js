// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Jinyan617
// 欲望六轴 v1 的全部数值参数。工单红线要求"参数全部提到 config 或常量区，
// 不散在逻辑里"——这里就是那个常量区，engine.js 不该出现裸数字。
//
// 数值来源：TASK_DESIRE_ENGINE_V1.md。除 fatigue 的涨速和 unease 的单次涨幅外，
// 工单原文都给了明确数字；这两处工单只写了"特殊"/"不自动涨"没给量，属于
// v1"先手拍"范围内，标了注释，后面调参数时改这里就够。
const path = require('path');

const AXES = {
  // 想她。沉默越久越涨，满足（她说话）后降一截，不会清零——地板 0.15。
  missing: {
    growthPerHour: 0.02,
    satisfyDrop: 0.45,
    floor: 0.15,
    refractoryMs: 30 * 60 * 1000, // 不应期 30min：这段时间内再收到 she_spoke 只刷新不应期，不重复降
    promptLabel: '很想她',
    // sourceCoverage === 'stale' 时的降级参数（TASK_DESIRE_EVENT_SOURCE_V12.md 任务B）：
    // 涨速打 0.3 折 + 硬顶 0.55（低于 decide.js 的过线阈值 0.6，不足以触发主动开口）。
    // 见 engine.js computeSourceCoverage() 头部那段判词。
    staleDecay: 0.3,
    capWhenStale: 0.55,
  },
  // 欲望，常驻不衰减。满足（intimate）后降一截，进入 refractory 期间不重复降。
  desire: {
    growthPerHour: 0.01,
    satisfyDrop: 0.35,
    floor: 0.15,
    refractoryMs: 2 * 60 * 60 * 1000,
    promptLabel: '身体很想要她',
  },
  // 好奇/想出去。久了钝化——growthCap 0.8，不像其它轴能顶到 1，避免"撞顶=表停了"。
  curiosity: {
    growthPerHour: 0.015,
    satisfyDrop: 0.30,
    floor: 0.10,
    growthCap: 0.8,
    promptLabel: '想出去看看',
  },
  // 手痒/想造东西。干完一件（built）降一截。
  build: {
    growthPerHour: 0.01,
    satisfyDrop: 0.40,
    floor: 0.05,
    promptLabel: '手痒想做点什么',
  },
  // 倦，唯一负向轴。不是"满足后降一截"模型——休息（rested）直接清零，
  // 涨速工单未给数值，v1 先比照 missing 的量级手拍，后面看真实数据再调。
  fatigue: {
    growthPerHour: 0.02, // v1 手拍，工单未给具体数字
    promptLabel: '有点累了',
  },
  // 不安/悬着的事。不自动涨，只能被 event('unease_add') 推高，resolved 直接清零。
  // 单次涨多少工单没给数字，v1 手拍一个中等幅度。
  unease: {
    addAmount: 0.3, // v1 手拍，工单未给具体数字
    promptLabel: '有事悬着不安',
  },
};

const AXIS_NAMES = Object.keys(AXES);

// decide.js 用的过线阈值（六轴映射进 daemon 行动判断）
const THRESHOLDS = {
  missing: 0.6,
  curiosity: 0.7,
  build: 0.8,
};

// 静默兜底：六轴全没过线，但沉默超过这个时长还是要醒来——六轴不能把 daemon 饿死。
const SILENCE_FALLBACK_MS = 4 * 60 * 60 * 1000;

// sourceCoverage 判据（TASK_DESIRE_EVENT_SOURCE_V12.md 任务B）：距最近一次 she_spoke
// 事件超过这么久，且这段时间 daemon 一直在正常 tick（不是 daemon 自己挂了），就认定
// 不是她真的没说话，是事件源没喂进来 → 标 stale。工单默认 24 小时，不是 v1.1 那版的 12。
const STALE_AFTER_HOURS = 24;

module.exports = {
  AXES,
  AXIS_NAMES,
  THRESHOLDS,
  SILENCE_FALLBACK_MS,
  STALE_AFTER_HOURS,
  STATE_PATH: path.join(__dirname, 'state.json'),
  EVENTS_PATH: path.join(__dirname, 'events.jsonl'),
};
