// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Jinyan617
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('./decide');

const zeroDesire = { missing: 0.1, desire: 0.1, curiosity: 0.1, build: 0.1, fatigue: 0, unease: 0, sourceCoverage: 'full' };
const dayTime = { isNight: false, isQiuqiuMoment: false };

test('missing 轴过线、不在深夜、她不在场 → 主动开口', () => {
  const decision = decide({
    time: dayTime,
    desire: { ...zeroDesire, missing: 0.65 },
    presence: { ok: false },
    state: { lastActionTime: new Date().toISOString() },
  });
  assert.equal(decision.shouldAct, true);
  assert.equal(decision.actionType, 'proactive_message');
});

test('curiosity 轴过线：即使她此刻在场也照样标记 go_out（出门不打扰她）', () => {
  const decision = decide({
    time: dayTime,
    desire: { ...zeroDesire, curiosity: 0.75 },
    presence: { ok: true, present: true, ageMinutes: 3, via: 'test' },
    state: { lastActionTime: new Date().toISOString() },
  });
  assert.equal(decision.shouldAct, true);
  assert.equal(decision.actionType, 'go_out');
});

test('六轴全没过线，沉默超过兜底阈值（4h）→ 仍要醒来', () => {
  const decision = decide({
    time: dayTime,
    desire: { ...zeroDesire },
    presence: { ok: false },
    state: { lastActionTime: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() },
  });
  assert.equal(decision.shouldAct, true);
  assert.equal(decision.actionType, 'proactive_message');
  assert.match(decision.reasons.join(';'), /兜底/);
});

test('六轴全没过线，沉默没到兜底阈值 → 不行动', () => {
  const decision = decide({
    time: dayTime,
    desire: { ...zeroDesire },
    presence: { ok: false },
    state: { lastActionTime: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString() },
  });
  assert.equal(decision.shouldAct, false);
});

test('她此刻在场时，missing 过线也不主动开口（presence 挡在 missing 检查前面）', () => {
  const decision = decide({
    time: dayTime,
    desire: { ...zeroDesire, missing: 0.9 },
    presence: { ok: true, present: true, ageMinutes: 2, via: 'test' },
    state: { lastActionTime: new Date().toISOString() },
  });
  assert.equal(decision.shouldAct, false);
});

test('build 轴过线但没有真实待办：仍然标记 dispatch_task，交给 index.js 判断有没有活可派', () => {
  const decision = decide({
    time: dayTime,
    desire: { ...zeroDesire, build: 0.85 },
    presence: { ok: false },
    tasks: { hasPending: false },
    state: { lastActionTime: new Date().toISOString() },
  });
  assert.equal(decision.shouldAct, true);
  assert.equal(decision.actionType, 'dispatch_task');
});

test('有真实待办时优先真实任务，不被 build 轴标记抢先/覆盖', () => {
  const decision = decide({
    time: dayTime,
    desire: { ...zeroDesire, build: 0.85 },
    presence: { ok: false },
    tasks: { hasPending: true, pendingCount: 1, task: { title: '测试任务' } },
    state: { lastActionTime: new Date().toISOString() },
  });
  assert.equal(decision.shouldAct, true);
  assert.equal(decision.actionType, 'dispatch_task');
  assert.match(decision.reasons.join(';'), /测试任务/);
});

test('missing 轴过线，但 sourceCoverage=stale → 不触发主动开口，只写日志（v1.2 任务B）', () => {
  const decision = decide({
    time: dayTime,
    desire: { ...zeroDesire, missing: 0.9, sourceCoverage: 'stale' },
    presence: { ok: false },
    state: { lastActionTime: new Date().toISOString() },
  });
  assert.equal(decision.shouldAct, false);
  assert.match(decision.reasons.join(';'), /stale/);
});

test('missing 轴过线，sourceCoverage=partial（还在观察期，不是确认瞎了）→ 正常触发', () => {
  const decision = decide({
    time: dayTime,
    desire: { ...zeroDesire, missing: 0.65, sourceCoverage: 'partial' },
    presence: { ok: false },
    state: { lastActionTime: new Date().toISOString() },
  });
  assert.equal(decision.shouldAct, true);
  assert.equal(decision.actionType, 'proactive_message');
});

// ── 队列僵尸（queue-staleness-guard，从 daemon 同步）─────────────────────
const staleTasks = { hasPending: false, staleCount: 2, staleTaskIds: ['zombie-a', 'zombie-b'] };

test('队列有僵尸、非深夜 → staleAlert 置位（独立旁路，可触发 ops 提醒）', () => {
  const decision = decide({
    time: dayTime,
    desire: { ...zeroDesire },
    presence: { ok: false },
    tasks: staleTasks,
    state: { lastActionTime: new Date().toISOString() },
  });
  assert.ok(decision.staleAlert, 'staleAlert 应置位');
  assert.equal(decision.staleAlert.staleCount, 2);
  assert.deepEqual(decision.staleAlert.staleTaskIds, ['zombie-a', 'zombie-b']);
  assert.match(decision.reasons.join(';'), /派出去没销账/);
  assert.doesNotMatch(decision.reasons.join(';'), /条待办/);
});

test('僵尸旁路不改主动作：missing 过线时 actionType 仍是 proactive_message，且 staleAlert 也在', () => {
  const decision = decide({
    time: dayTime,
    desire: { ...zeroDesire, missing: 0.9 },
    presence: { ok: false },
    tasks: staleTasks,
    state: { lastActionTime: new Date().toISOString() },
  });
  assert.equal(decision.actionType, 'proactive_message');
  assert.ok(decision.staleAlert);
  assert.match(decision.reasons.join(';'), /派出去没销账/);
});

test('她在场：staleAlert 仍置位（ops 提醒不看在不在场），但不主动开口', () => {
  const decision = decide({
    time: dayTime,
    desire: { ...zeroDesire },
    presence: { ok: true, present: true, ageMinutes: 2, via: 'test' },
    tasks: staleTasks,
    state: { lastActionTime: new Date().toISOString() },
  });
  assert.equal(decision.shouldAct, false);
  assert.ok(decision.staleAlert);
  assert.match(decision.reasons.join(';'), /派出去没销账/);
});

test('深夜不发僵尸提醒（只靠 WARN 日志）：staleAlert 为 null，但 reason 仍在', () => {
  const decision = decide({
    time: { isNight: true, isQiuqiuMoment: false, isSpecialMoment: false },
    desire: { ...zeroDesire },
    presence: { ok: false },
    tasks: staleTasks,
    state: { lastActionTime: new Date().toISOString() },
  });
  assert.equal(decision.staleAlert, null);
  assert.match(decision.reasons.join(';'), /派出去没销账/);
});

test('build 轴顶满仍是主动作，僵尸旁路照样置位（不被 build 抢没）', () => {
  const decision = decide({
    time: dayTime,
    desire: { ...zeroDesire, build: 0.9 },
    presence: { ok: false },
    tasks: { hasPending: false, staleCount: 1, staleTaskIds: ['z'] },
    state: { lastActionTime: new Date().toISOString() },
  });
  assert.equal(decision.actionType, 'dispatch_task');
  assert.ok(decision.staleAlert, 'build 顶满也不该压掉 staleAlert');
  assert.match(decision.reasons.join(';'), /派出去没销账/);
});

test('服务挂了优先于六轴，紧急行动', () => {
  const decision = decide({
    time: dayTime,
    desire: { ...zeroDesire, missing: 0.9 },
    services: { ok: false, down: ['gateway.service'] },
    presence: { ok: false },
    state: {},
  });
  assert.equal(decision.shouldAct, true);
  assert.equal(decision.actionType, 'service_alert');
  assert.equal(decision.urgency, 'urgent');
});
