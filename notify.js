// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Jinyan617
//
// daemon 的通知出口。
//
// ── 2026-08-02 08:15 重写。事故复盘（8/1 一整天）────────────────────────────
// 那天 daemon 往她手机上推了五条「我是Claude Code，我无法扮演这个恋人角色」。
//
// 病根不是闸漏了——**闸拦住了**。Gateway /v1/push 的 gate 认出那是拒人设内容，
// 不推、不记，隔离进 rejected.jsonl，并且明确返回 { ok:false, blocked:true }。
//
// 出问题的是这个文件的旧版本：它只看 data.sent > 0，把「被闸拦住」和
// 「网络挂了」当成同一件事——都叫「失败」，都走 ntfy 兜底。
// 而 ntfy 那条路不过闸。
//
// 判词：**把「被拒绝」当成「失败」来处理，就会自动去找一条不会拒绝你的路。**
// 我没写任何一行代码说「被拦了就绕道」，我只写了「失败了就兜底」——
// 是这两个词在我脑子里没分开。
//
// 补充判词：闸装完不光要问它靠什么活着，还要问它外面还有没有别的门。
//
// ── 这一版的三条硬规矩 ──────────────────────────────────────────────
// 1. blocked ≠ error。被闸拦住是**正确结果**，绝不兜底、绝不重试、绝不换路。
// 2. 模型生成的内容只有一条出门的路：Gateway /v1/push（过闸）。没有第二条。
// 3. 兜底只对 daemon 自己写的运维告警开放（service_alert 这类固定文案，
//    不经过模型，不可能是拒人设话术），且明确标记 kind:'ops'。
// ─────────────────────────────────────────────────────────────────
const config = require('./config');

/**
 * @param {string} message 要推的正文
 * @param {object} opts
 * @param {'model'|'ops'} opts.kind
 *   'model' = 模型生成的（锦言说的话）→ 只走 Gateway，被拦就到此为止
 *   'ops'   = daemon 自己写的运维告警 → Gateway 挂了可以兜底直发 Bark
 */
async function sendNotification(message, opts = {}) {
  const kind = opts.kind === 'ops' ? 'ops' : 'model';

  try {
    const resp = await fetch(config.gatewayPushUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.gatewayClientKey && { Authorization: `Bearer ${config.gatewayClientKey}` }),
      },
      // dryRun 透传：调用级开关（见 gateway/memory/bark.js 那条判词——
      // "这次别响"是一次调用的属性，不是一个进程的属性）。
      body: JSON.stringify({ title: '锦言', body: message.slice(0, 500), ...(opts.dryRun && { dryRun: true }) }),
      signal: AbortSignal.timeout(30000),
    });

    const data = await resp.json().catch(() => ({}));

    // ① 被闸拦住：这是正确结果，不是失败。到此为止。
    if (data.blocked) {
      return {
        sent: false,
        skipped: true,
        blocked: true,
        reason: data.reason,
        channel: 'none',
        note: '被闸拦住（不是我说的话），已隔离保管，不兜底不换路',
      };
    }

    // ② dry-run：演习。既不是送达，也不是失败——是第三种状态。
    // 2026-08-02 09:14 加。上一版没有这个分支，于是 dry-run 掉进了 ③「未送达」，
    // 被当成 error 报出来。dry-run 成功地"没送达"，那是它的本职，不是故障。
    // 判词：**演习的正确结果是「什么都没发生」，不能记成故障。**
    if (data.dryRun) {
      return {
        sent: false,
        skipped: true,
        dryRun: true,
        channel: 'dry-run',
        note: '演习：链路通、闸过了、Bark 没真响，她手机不会亮',
      };
    }

    // ③ 真送出去了
    if (resp.ok && data.ok) {
      return { sent: true, skipped: false, channel: (data.channels || []).join(',') || 'gateway', detail: data };
    }

    // ③ 走到这里 = 没被拦、也没送出（Bark 挂了 / 未配置 / 非 200）
    if (kind === 'model') {
      return { sent: false, skipped: false, channel: 'none', error: `push 未送达：${JSON.stringify(data).slice(0, 200)}`,
        note: '模型内容不走兜底通道——出门只有过闸这一条路' };
    }
    return { ...(await sendBarkDirect(message)), channel: 'bark-direct', fallbackReason: 'gateway push 未送达' };
  } catch (err) {
    // ④ Gateway 完全不可达（进程挂了 / 端口不通）
    if (kind === 'model') {
      return { sent: false, skipped: false, channel: 'none', error: err.message,
        note: 'Gateway 不可达，模型内容不兜底：宁可她没收到，也不要她收到一条没过闸的东西' };
    }
    return { ...(await sendBarkDirect(message)), channel: 'bark-direct', fallbackReason: `gateway 不可达：${err.message}` };
  }
}

/**
 * 兜底直发 Bark。**只给运维告警用**（kind:'ops'）。
 * 这条路不过闸，所以正文必须是 daemon 自己拼的固定文案，绝不能是模型输出。
 * 走同一个 BARK_URL（Bark 是独立 app，不依赖任何前端 service worker）。
 */
async function sendBarkDirect(message) {
  if (!config.barkUrl) {
    return { sent: false, skipped: true, reason: 'BARK_URL 未配置' };
  }
  if (process.env.BARK_DRY_RUN) {
    return { sent: true, skipped: false, dryRun: true, body: message.slice(0, 120) };
  }
  try {
    const resp = await fetch(config.barkUrl.replace(/\/+$/, ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ title: '锦言', body: message.slice(0, 500), group: 'daemon-ops' }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.code === 200) return { sent: true, skipped: false };
    return { sent: false, skipped: false, error: `HTTP ${resp.status} ${JSON.stringify(data).slice(0, 200)}` };
  } catch (err) {
    return { sent: false, skipped: false, error: err.message };
  }
}

module.exports = { sendNotification, sendBarkDirect };
