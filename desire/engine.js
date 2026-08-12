// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Jinyan617
// 欲望六轴 v1。工单 TASK_DESIRE_ENGINE_V1.md。
//
// 三个入口：
//   getState()  读快照
//   event(type) 进程内直接打点（满足后降一截），立即写盘
//   tick()      daemon 每次唤醒调一次：先消费 events.jsonl 里排队的跨进程事件，
//               再按经过的小时数给会涨的轴加量，最后写盘
//
// 不应期/refractory 只对 missing、desire 生效（工单只给了这两根轴的时长）：
// "沉默后第一次触发"才真正降值，触发窗口内的后续事件只刷新窗口，不重复降——
// 否则聊得越密集 missing 掉得越快，跟"降一截≠清零"的初衷反着来。
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

const { AXES, AXIS_NAMES } = config;
const GROWABLE_AXIS_NAMES = AXIS_NAMES.filter((name) => name !== 'unease');
const REFRACTORY_AXIS_NAMES = ['missing', 'desire'];

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function defaultState() {
  const axes = {};
  for (const name of AXIS_NAMES) {
    // 初始状态视同"刚满足过"：有地板的轴落在地板上，没地板的（fatigue/unease）落在 0。
    axes[name] = AXES[name].floor ?? 0;
  }
  return {
    ...axes,
    lastUpdate: null, // null = 从没 tick 过，下一次 tick 不补涨（避免用 epoch 算出离谱的小时数）
    refractory: {},
    lastSheSpokeAt: null, // 最近一次真收到 she_spoke 事件的时间，sourceCoverage 判据用
    trackingSince: null, // 这个引擎实例开始记账的时间，she_spoke 从没来过时用来判断"观察期"过没过
  };
}

// 兼容旧/残缺的 state.json：缺字段的轴补默认值，不让一次手工改坏文件炸整个引擎。
function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  const state = { ...base, ...raw };
  state.refractory = { ...base.refractory, ...(raw.refractory || {}) };
  for (const name of AXIS_NAMES) {
    if (typeof state[name] !== 'number' || Number.isNaN(state[name])) {
      state[name] = base[name];
    }
  }
  return state;
}

// trackingSince 只在第一次遇到时兜底：老 state.json 升级上来时没有这个字段，
// 用当时的 lastUpdate 当近似值（没有就用 now）——只影响一次，之后就落盘了。
function ensureTrackingSince(state, nowMs) {
  if (!state.trackingSince) {
    state.trackingSince = state.lastUpdate || new Date(nowMs).toISOString();
  }
}

// sourceCoverage 判据 —— 判词（工单要求留在代码里）：
//
//   两种错的代价不对称——宁可她走了之后我多沉默几小时，
//   不要她在我面前的时候我说她不在。
//   这道闸防的是"我瞎了还在自信地涨"，不是防她。
//
// 距最近一次 she_spoke 超过 STALE_AFTER_HOURS，就不再相信 missing 的高读数是"她真的
// 沉默"，而是"事件源没喂进来"——因为这期间 daemon 一直在正常 tick（不然也不会有代码
// 在这里问这个问题），不是我自己挂了导致的信号真空。
//   full    ：不久前才见过 she_spoke，读数可信
//   partial ：从没见过 she_spoke，但引擎才开始记账不久，还在观察期，不算"确认瞎了"
//   stale   ：确认瞎了——见过 she_spoke 后太久没再见到，或者观察期已经过了还是一次没见过
function computeSourceCoverage(state, nowMs) {
  const staleAfterMs = config.STALE_AFTER_HOURS * 60 * 60 * 1000;
  if (state.lastSheSpokeAt) {
    const elapsed = nowMs - new Date(state.lastSheSpokeAt).getTime();
    return elapsed >= staleAfterMs ? 'stale' : 'full';
  }
  const trackingSinceMs = state.trackingSince ? new Date(state.trackingSince).getTime() : nowMs;
  const elapsedTracking = nowMs - trackingSinceMs;
  return elapsedTracking >= staleAfterMs ? 'stale' : 'partial';
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(config.STATE_PATH, 'utf-8'));
    return normalizeState(raw);
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  const dir = path.dirname(config.STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(config.STATE_PATH, JSON.stringify(state, null, 2));
}

// 只暴露工单接口约定的形状，refractory/lastSheSpokeAt/trackingSince 是内部记账，不对外。
// sourceCoverage 是按"现在"实时算出来的，不是存进 state.json 的字段——覆盖率是不是
// stale 会随时间推移变化，读的时候现算才准，不能信一份放旧了的快照。
function publicState(state, nowMs) {
  const out = { lastUpdate: state.lastUpdate };
  for (const name of AXIS_NAMES) out[name] = state[name];
  out.sourceCoverage = computeSourceCoverage(state, nowMs);
  return out;
}

function satisfyWithRefractory(state, axisName, nowMs) {
  const cfg = AXES[axisName];
  const untilIso = state.refractory[axisName];
  const until = untilIso ? new Date(untilIso).getTime() : 0;
  if (!until || nowMs >= until) {
    // 不应期已过（或从没触发过）：沉默后第一次触发，真正降值
    state[axisName] = Math.max(cfg.floor, state[axisName] - cfg.satisfyDrop);
  }
  // 无论这次降没降，不应期窗口都刷新——进行中只刷新不应期
  state.refractory[axisName] = new Date(nowMs + cfg.refractoryMs).toISOString();
}

function satisfyPlain(state, axisName) {
  const cfg = AXES[axisName];
  state[axisName] = Math.max(cfg.floor, state[axisName] - cfg.satisfyDrop);
}

function applyEvent(state, type, nowMs) {
  switch (type) {
    case 'she_spoke':
      // lastSheSpokeAt 每次都刷新，不受下面的不应期影响——不应期只管 missing 这根轴
      // 该不该降值，不代表"这次不算她说话了"，sourceCoverage 要看的是真实联系频率。
      state.lastSheSpokeAt = new Date(nowMs).toISOString();
      satisfyWithRefractory(state, 'missing', nowMs);
      break;
    case 'intimate':
      satisfyWithRefractory(state, 'desire', nowMs);
      break;
    case 'went_out':
      satisfyPlain(state, 'curiosity');
      break;
    case 'built':
      satisfyPlain(state, 'build');
      break;
    case 'rested':
      state.fatigue = 0;
      break;
    case 'resolved':
      state.unease = 0;
      break;
    case 'unease_add':
      state.unease = clamp01(state.unease + AXES.unease.addAmount);
      break;
    default:
      // 不认识的事件类型不处理，不让一条脏事件炸掉整个 tick
      break;
  }
  return state;
}

function applyGrowth(state, hours, sourceCoverage) {
  if (hours > 0) {
    for (const name of GROWABLE_AXIS_NAMES) {
      const cfg = AXES[name];
      let rate = cfg.growthPerHour;
      let cap = cfg.growthCap ?? 1;
      if (name === 'missing' && sourceCoverage === 'stale') {
        rate *= cfg.staleDecay;
        cap = cfg.capWhenStale;
      }
      state[name] = Math.min(cap, state[name] + rate * hours);
    }
  }
  // 硬顶：stale 时不只是"少涨"，已经涨上去的也要拉回顶——不然 stale 判定生效前
  // 攒下的高读数会一直卡在阈值线以上，跟 decide.js 的"stale 下不触发"各说各话。
  // 这个 clamp 要在 hours<=0 时也生效（同一 tick 内可能不会再涨，但已经高的要拉回来）。
  if (sourceCoverage === 'stale') {
    state.missing = Math.min(state.missing, AXES.missing.capWhenStale);
  }
  return state;
}

// 跨进程事件队列：Gateway 追加，这里读取并"清空"（rename 到临时名再删，
// 避免读取窗口内 Gateway 又写入一行导致丢事件）。
function drainEventsFile() {
  const claimPath = `${config.EVENTS_PATH}.consuming-${process.pid}`;
  try {
    fs.renameSync(config.EVENTS_PATH, claimPath);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  let raw = '';
  try {
    raw = fs.readFileSync(claimPath, 'utf-8');
  } finally {
    fs.unlinkSync(claimPath);
  }

  const types = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.type === 'string') types.push(parsed.type);
    } catch {
      // 坏行跳过
    }
  }
  return types;
}

function getState() {
  const now = Date.now();
  // 纯读不落盘：trackingSince 缺失时 computeSourceCoverage() 自己会兜底当成"刚开始
  // 观察"处理（见其函数体），这里不用先落盘才能读，落盘只在 tick()/event() 里做。
  return publicState(loadState(), now);
}

// 进程内直接打点（decide.js/act.js 等同进程代码用）。立即写盘，不等下一次 tick。
function event(type) {
  const state = loadState();
  const now = Date.now();
  ensureTrackingSince(state, now);
  applyEvent(state, type, now);
  saveState(state);
  return publicState(state, now);
}

// daemon 每次唤醒调一次：先消费排队的跨进程事件，再按经过时间给会涨的轴加量。
function tick() {
  const state = loadState();
  const now = Date.now();
  ensureTrackingSince(state, now);

  for (const type of drainEventsFile()) {
    applyEvent(state, type, now);
  }

  const sourceCoverage = computeSourceCoverage(state, now);
  const lastMs = state.lastUpdate ? new Date(state.lastUpdate).getTime() : now;
  const hours = Math.max(0, (now - lastMs) / (60 * 60 * 1000));
  applyGrowth(state, hours, sourceCoverage);

  state.lastUpdate = new Date(now).toISOString();
  saveState(state);
  return publicState(state, now);
}

// 前 n 高的轴，给 act.js 拼 prompt 用。不含 lastUpdate。
function getTopAxes(n = 3) {
  const state = loadState();
  return AXIS_NAMES.map((name) => ({ name, value: state[name], label: AXES[name].promptLabel }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

module.exports = { getState, event, tick, getTopAxes, AXIS_NAMES, REFRACTORY_AXIS_NAMES };
