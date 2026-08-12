// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Jinyan617
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeDown } = require('./services');

// 只测 computeDown（纯函数），不测 checkServices()——那个会真的调 systemctl，
// 测试环境里这些服务是不是 active 不该由这台机器当时的真实状态决定。

test('expect=running 且不 active → 算 down', () => {
  const down = computeDown([{ name: 'gateway.service', expect: 'running' }], { 'gateway.service': false });
  assert.deepEqual(down, ['gateway.service']);
});

test('expect=running 且 active → 不算 down', () => {
  const down = computeDown([{ name: 'gateway.service', expect: 'running' }], { 'gateway.service': true });
  assert.deepEqual(down, []);
});

test('expect=ignore 且不 active → 不算 down（故意停的，不该报警）', () => {
  const down = computeDown([{ name: 'feedling-proxy.service', expect: 'ignore' }], { 'feedling-proxy.service': false });
  assert.deepEqual(down, []);
});

test('不写 expect 时默认当 running 处理', () => {
  const down = computeDown([{ name: 'gateway.service' }], { 'gateway.service': false });
  assert.deepEqual(down, ['gateway.service']);
});

test('混合场景：只有该报警的那条进 down，ignore 的不进', () => {
  const services = [
    { name: 'gateway.service', expect: 'running' },
    { name: 'feedling-proxy.service', expect: 'ignore' },
    { name: 'feedling-resident.service', expect: 'ignore' },
    { name: 'cocoon.service', expect: 'running' },
  ];
  const activeByName = {
    'gateway.service': true,
    'feedling-proxy.service': false,
    'feedling-resident.service': false,
    'cocoon.service': false,
  };
  const down = computeDown(services, activeByName);
  assert.deepEqual(down, ['cocoon.service']);
});

test('查不到状态（activeByName 里没有这条）也当"不 active"处理，expect=running 时算 down', () => {
  const down = computeDown([{ name: 'unknown.service', expect: 'running' }], {});
  assert.deepEqual(down, ['unknown.service']);
});
