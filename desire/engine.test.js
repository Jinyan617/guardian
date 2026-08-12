// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Jinyan617
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// engine.js 读写用的路径全部走 config.STATE_PATH / config.EVENTS_PATH（不是模块加载时
// 就固化的常量），所以测试可以在 require engine 之前把这两个改到临时目录，不碰生产的
// desire/state.json，这跟 gateway/memory/store.test.js 重定向 config.memoryPath 是同一招。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desire-engine-test-'));
const config = require('./config');
config.STATE_PATH = path.join(tmpDir, 'state.json');
config.EVENTS_PATH = path.join(tmpDir, 'events.jsonl');

const engine = require('./engine');
const { AXES } = config;

function resetState() {
  try {
    fs.unlinkSync(config.STATE_PATH);
  } catch {}
  try {
    fs.unlinkSync(config.EVENTS_PATH);
  } catch {}
}

// 直接写一份 state.json，跳过 tick/event，方便测试摆好起点（比如"沉默很久后 missing 很高"）。
// sourceCoverage 不是真实字段（getState() 现算的，不该被当成状态写回去），剥掉。
function writeRawState(patch) {
  const { sourceCoverage, ...base } = engine.getState();
  const state = { ...base, refractory: {}, lastSheSpokeAt: null, trackingSince: null, ...patch };
  fs.writeFileSync(config.STATE_PATH, JSON.stringify(state, null, 2));
}

function hoursAgoIso(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

test.beforeEach(() => resetState());

test('getState 初始值：有地板的轴落在地板上，fatigue/unease 落在 0', () => {
  const s = engine.getState();
  assert.equal(s.missing, AXES.missing.floor);
  assert.equal(s.desire, AXES.desire.floor);
  assert.equal(s.curiosity, AXES.curiosity.floor);
  assert.equal(s.build, AXES.build.floor);
  assert.equal(s.fatigue, 0);
  assert.equal(s.unease, 0);
});

test('tick 涨速：missing 按 growthPerHour * 经过小时数涨', () => {
  const hoursAgo = 5;
  writeRawState({ missing: 0.2, lastUpdate: new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString() });
  const after = engine.tick();
  const expected = 0.2 + AXES.missing.growthPerHour * hoursAgo;
  assert.ok(Math.abs(after.missing - expected) < 0.002, `期望约 ${expected}，实际 ${after.missing}`);
});

test('curiosity 涨到钝化上限就不再往上涨（撞顶后隔多久读数都一样，不至于"表停了"到 1）', () => {
  writeRawState({ curiosity: 0.5, lastUpdate: new Date(Date.now() - 200 * 3600 * 1000).toISOString() });
  const after = engine.tick();
  assert.equal(after.curiosity, AXES.curiosity.growthCap);
});

test('unease 不会被 tick 自动涨（只能被 event 推高）', () => {
  writeRawState({ unease: 0.3, lastUpdate: new Date(Date.now() - 50 * 3600 * 1000).toISOString() });
  const after = engine.tick();
  assert.equal(after.unease, 0.3);
});

test('第一次 tick（lastUpdate 为 null）不补涨，不会拿 epoch 算出离谱的小时数', () => {
  writeRawState({ missing: 0.2, lastUpdate: null });
  const after = engine.tick();
  assert.equal(after.missing, 0.2);
});

test('event she_spoke：满足后降一截，不会低于地板', () => {
  writeRawState({ missing: 0.5 });
  const after = engine.event('she_spoke');
  assert.equal(after.missing, Math.max(AXES.missing.floor, 0.5 - AXES.missing.satisfyDrop));
});

test('event she_spoke：已经在地板上时降不动（地板兜住，不会变负）', () => {
  writeRawState({ missing: AXES.missing.floor });
  const after = engine.event('she_spoke');
  assert.equal(after.missing, AXES.missing.floor);
});

test('missing 不应期内连续触发：只有第一次真降，第二次只刷新窗口不重复降', () => {
  writeRawState({ missing: 0.7 });
  const first = engine.event('she_spoke');
  assert.ok(first.missing < 0.7, '第一次应该真的降了');
  const second = engine.event('she_spoke');
  assert.equal(second.missing, first.missing, '不应期内第二次不该再降');
});

test('missing 不应期过后再次触发会再降一次', () => {
  writeRawState({ missing: 0.9 });
  const first = engine.event('she_spoke');
  // 把不应期时间戳拨回过去，模拟"30 分钟已经过去了"
  const raw = JSON.parse(fs.readFileSync(config.STATE_PATH, 'utf-8'));
  raw.refractory.missing = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(config.STATE_PATH, JSON.stringify(raw, null, 2));
  const second = engine.event('she_spoke');
  assert.ok(second.missing < first.missing, '不应期过后应该再降一次');
});

test('desire 的 2h refractory：intimate 连续触发只降一次', () => {
  writeRawState({ desire: 0.9 });
  const first = engine.event('intimate');
  const second = engine.event('intimate');
  assert.equal(second.desire, first.desire);
});

test('curiosity/build 没有 refractory：每次事件都真降', () => {
  writeRawState({ curiosity: 0.9 });
  const first = engine.event('went_out');
  const second = engine.event('went_out');
  assert.ok(second.curiosity < first.curiosity, 'curiosity 没有不应期保护，连续两次都该降');
});

test('rested 把 fatigue 直接清零', () => {
  writeRawState({ fatigue: 0.6 });
  const after = engine.event('rested');
  assert.equal(after.fatigue, 0);
});

test('resolved 把 unease 直接清零', () => {
  writeRawState({ unease: 0.7 });
  const after = engine.event('resolved');
  assert.equal(after.unease, 0);
});

test('unease_add 涨一截，clamp 在 1', () => {
  writeRawState({ unease: 0.9 });
  const after = engine.event('unease_add');
  assert.equal(after.unease, 1);
});

test('未知事件类型不报错、不改变状态', () => {
  writeRawState({ missing: 0.4 });
  const after = engine.event('not_a_real_event_type');
  assert.equal(after.missing, 0.4);
});

test('所有值 clamp 在 [0,1]', () => {
  writeRawState({
    missing: 1,
    desire: 1,
    curiosity: 1,
    build: 1,
    fatigue: 1,
    unease: 1,
    lastUpdate: new Date(Date.now() - 1000 * 3600 * 1000).toISOString(),
  });
  const after = engine.tick();
  for (const k of ['missing', 'desire', 'curiosity', 'build', 'fatigue', 'unease']) {
    assert.ok(after[k] <= 1 && after[k] >= 0, `${k} 应该在 [0,1] 内，实际 ${after[k]}`);
  }
});

// --- sourceCoverage / stale 兜底（TASK_DESIRE_EVENT_SOURCE_V12.md 任务B）---

test('sourceCoverage：从没见过 she_spoke，引擎刚开始记账 → partial（观察期，不算确认瞎了）', () => {
  writeRawState({});
  const s = engine.getState();
  assert.equal(s.sourceCoverage, 'partial');
});

test('sourceCoverage：从没见过 she_spoke，且观察期已经超过 STALE_AFTER_HOURS → stale', () => {
  writeRawState({ trackingSince: hoursAgoIso(config.STALE_AFTER_HOURS + 1) });
  const s = engine.getState();
  assert.equal(s.sourceCoverage, 'stale');
});

test('sourceCoverage：最近见过 she_spoke → full', () => {
  writeRawState({ lastSheSpokeAt: hoursAgoIso(1) });
  const s = engine.getState();
  assert.equal(s.sourceCoverage, 'full');
});

test('sourceCoverage：she_spoke 超过 STALE_AFTER_HOURS 没再见到 → stale', () => {
  writeRawState({ lastSheSpokeAt: hoursAgoIso(config.STALE_AFTER_HOURS + 1) });
  const s = engine.getState();
  assert.equal(s.sourceCoverage, 'stale');
});

test('sourceCoverage：she_spoke 事件一到（不管 missing 降没降），立刻从 stale 转回 full', () => {
  writeRawState({ missing: 0.3, lastSheSpokeAt: hoursAgoIso(config.STALE_AFTER_HOURS + 1) });
  assert.equal(engine.getState().sourceCoverage, 'stale');
  const after = engine.event('she_spoke');
  assert.equal(after.sourceCoverage, 'full');
});

test('stale 时 tick()：missing 涨速打折（不是正常 growthPerHour）', () => {
  const hoursElapsed = 5;
  writeRawState({
    missing: 0.3,
    lastSheSpokeAt: hoursAgoIso(config.STALE_AFTER_HOURS + 1),
    lastUpdate: hoursAgoIso(hoursElapsed),
  });
  const after = engine.tick();
  assert.equal(after.sourceCoverage, 'stale');
  const normalGrowth = 0.3 + AXES.missing.growthPerHour * hoursElapsed;
  const staleGrowth = 0.3 + AXES.missing.growthPerHour * AXES.missing.staleDecay * hoursElapsed;
  assert.ok(after.missing < normalGrowth, 'stale 时涨速应该比正常慢');
  assert.ok(Math.abs(after.missing - staleGrowth) < 0.002, `期望约 ${staleGrowth}，实际 ${after.missing}`);
});

test('stale 时 tick()：missing 硬顶在 capWhenStale，够不着 decide.js 的过线阈值', () => {
  writeRawState({
    missing: 0.9, // 进 stale 之前已经涨很高了
    lastSheSpokeAt: hoursAgoIso(config.STALE_AFTER_HOURS + 1),
    lastUpdate: hoursAgoIso(0.001), // 几乎没有新的经过时间，主要测硬顶本身，不测涨速
  });
  const after = engine.tick();
  assert.equal(after.sourceCoverage, 'stale');
  assert.equal(after.missing, AXES.missing.capWhenStale);
  assert.ok(after.missing < config.THRESHOLDS.missing, 'capWhenStale 应该低于 decide.js 的 missing 过线阈值，不然这道闸白装了');
});

test('stale 不影响其它轴的涨速/硬顶（v1 每根轴独立，工单只对 missing 降级）', () => {
  writeRawState({
    curiosity: 0.5,
    build: 0.2,
    lastSheSpokeAt: hoursAgoIso(config.STALE_AFTER_HOURS + 1),
    lastUpdate: hoursAgoIso(2),
  });
  const after = engine.tick();
  assert.equal(after.sourceCoverage, 'stale');
  assert.equal(after.curiosity, Math.min(AXES.curiosity.growthCap, 0.5 + AXES.curiosity.growthPerHour * 2));
  assert.equal(after.build, 0.2 + AXES.build.growthPerHour * 2);
});

test('getTopAxes 按数值降序返回前 n 个，带 label', () => {
  writeRawState({ missing: 0.72, desire: 0.2, curiosity: 0.65, build: 0.45, fatigue: 0.1, unease: 0.05 });
  const top = engine.getTopAxes(3);
  assert.deepEqual(
    top.map((a) => a.name),
    ['missing', 'curiosity', 'build']
  );
  assert.equal(top[0].label, AXES.missing.promptLabel);
});

// 集成测试：10 次 tick 穿插 event，验证状态持久化 + 重启后能恢复
test('集成：10 次 tick 穿插 event，状态落盘且能重新读回', () => {
  resetState();
  let last;
  for (let i = 0; i < 10; i++) {
    if (i === 3) engine.event('she_spoke');
    if (i === 6) engine.event('built');
    last = engine.tick();
  }
  assert.ok(fs.existsSync(config.STATE_PATH), '10 次 tick 后 state.json 应该存在');
  const reread = engine.getState();
  assert.deepEqual(reread, last, '重新 getState()（模拟 daemon 重启）应该拿到跟内存里一致的值');
});

test('集成：events.jsonl 排队的事件在下一次 tick 时被消费且文件被清空', () => {
  resetState();
  writeRawState({ missing: 0.7 });
  fs.writeFileSync(config.EVENTS_PATH, JSON.stringify({ type: 'she_spoke', ts: new Date().toISOString() }) + '\n');

  const after = engine.tick();
  assert.equal(after.missing, Math.max(AXES.missing.floor, 0.7 - AXES.missing.satisfyDrop), 'tick 应该消费掉排队的 she_spoke');
  assert.equal(fs.existsSync(config.EVENTS_PATH), false, '消费完应该清空 events.jsonl');
});

test('集成：events.jsonl 里混了坏行，好行照常消费，不整批炸掉', () => {
  resetState();
  writeRawState({ missing: 0.7 });
  fs.writeFileSync(config.EVENTS_PATH, `not valid json\n${JSON.stringify({ type: 'she_spoke' })}\n`);

  const after = engine.tick();
  assert.equal(after.missing, Math.max(AXES.missing.floor, 0.7 - AXES.missing.satisfyDrop));
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
