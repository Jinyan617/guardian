// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Jinyan617
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findStale } = require('./tasks');

// 只测 findStale（纯函数）——checkTasks 会读真实 pending-tasks.json，
// 那条路由 index.js 的集成跑覆盖（QUEUE_GUARD_RESULT.md）。
// 僵尸 = status=dispatched 且 dispatchedAt 距 now 超过 72h。

const now = Date.parse('2026-08-18T00:00:00Z');
const H = 60 * 60 * 1000;

test('dispatched 超 72h → 算 stale', () => {
  const tasks = [{ id: 'old', status: 'dispatched', dispatchedAt: new Date(now - 100 * H).toISOString() }];
  assert.deepEqual(findStale(tasks, now).map((t) => t.id), ['old']);
});

test('dispatched 但没到 72h → 不算 stale', () => {
  const tasks = [{ id: 'fresh', status: 'dispatched', dispatchedAt: new Date(now - 8 * H).toISOString() }];
  assert.deepEqual(findStale(tasks, now), []);
});

test('恰好 72h 边界 → 算 stale（>=）', () => {
  const tasks = [{ id: 'edge', status: 'dispatched', dispatchedAt: new Date(now - 72 * H).toISOString() }];
  assert.deepEqual(findStale(tasks, now).map((t) => t.id), ['edge']);
});

test('pending / completed / 没有 dispatchedAt 的 dispatched → 都不算 stale', () => {
  const tasks = [
    { id: 'pend', status: 'pending' },
    { id: 'done', status: 'completed', dispatchedAt: new Date(now - 100 * H).toISOString() },
    { id: 'nodate', status: 'dispatched' },
    { id: 'baddate', status: 'dispatched', dispatchedAt: 'not-a-date' },
  ];
  assert.deepEqual(findStale(tasks, now), []);
});

test('多条只挑真 stale 的，顺序保持', () => {
  const tasks = [
    { id: 'a', status: 'dispatched', dispatchedAt: new Date(now - 200 * H).toISOString() },
    { id: 'b', status: 'dispatched', dispatchedAt: new Date(now - 10 * H).toISOString() },
    { id: 'c', status: 'dispatched', dispatchedAt: new Date(now - 80 * H).toISOString() },
  ];
  assert.deepEqual(findStale(tasks, now).map((t) => t.id), ['a', 'c']);
});
