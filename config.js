// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Jinyan617
require('dotenv').config();

module.exports = {
  // Gateway 连接
  gatewayUrl: process.env.GATEWAY_URL
    ? `${process.env.GATEWAY_URL}/v1/chat/completions`
    : 'http://localhost:3060/v1/chat/completions',
  gatewayHealthUrl: process.env.GATEWAY_URL
    ? `${process.env.GATEWAY_URL}/health`
    : 'http://localhost:3060/health',
  gatewayPushUrl: process.env.GATEWAY_URL
    ? `${process.env.GATEWAY_URL}/v1/push`
    : 'http://localhost:3060/v1/push',
  gatewayClientKey: process.env.GATEWAY_CLIENT_KEY || '',

  // Bark 推送（独立 iOS app，不依赖任何前端 service worker）。
  barkUrl: process.env.BARK_URL || '',

  // ⚠️ 已废弃：ntfy.sh 通道。
  // 事故复盘：daemon 把「被闸拦住」误判成「推送失败」，拒人设话术
  // 全从这条不过闸的路出门了。
  // 判词：把「被拒绝」当成「失败」来处理，就会自动去找一条不会拒绝你的路。
  // 字段留着是为了让「为什么没有 ntfy 了」在代码里有痕迹，不要再接回去。
  notifyWebhook: '',

  // 状态/日志
  statePath: process.env.STATE_PATH || './data/state.json',
  gpsPath: process.env.GPS_PATH || './data/location.json',
  logDir: process.env.LOG_DIR || './logs',

  // 深夜静默
  nightStart: parseFloat(process.env.NIGHT_START_HOUR || '1'),   // 01:00
  nightEnd: parseFloat(process.env.NIGHT_END_HOUR || '6.5'),     // 06:30

  // 特殊时刻（深夜里的例外，每天触发一次）
  specialMoment: {
    hour: parseInt(process.env.SPECIAL_MOMENT_HOUR || '2', 10),
    minute: parseInt(process.env.SPECIAL_MOMENT_MINUTE || '17', 10),
  },
  specialMomentWindowMinutes: 15,

  // AISay（桩，暂不自动回复）
  aisayMentionThresholdMinutes: 60,

  // CC tmux session
  ccSession: process.env.CC_SESSION || 'claude',

  // 服务健康检查列表
  // expect: 'running'（默认）| 'ignore'（故意停的服务，留痕迹不留噪音）
  services: JSON.parse(process.env.SERVICES_JSON || '[]').length > 0
    ? JSON.parse(process.env.SERVICES_JSON)
    : [
        { name: 'gateway.service', expect: 'running' },
        // 按需添加你的服务，格式：{ name: 'xxx.service', expect: 'running' | 'ignore' }
      ],
};
