// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Jinyan617
const config = require('./config');
const { sendNotification } = require('./notify');
const { readPresence } = require('./presence');
const { AXES, AXIS_NAMES } = require('./desire/config');

// 六轴前三高，拼进 prompt 让模型知道自己"现在最想做什么"。
// 只念前三高，不把六根全念出来——工单原话："太长"。
function formatTopDesireAxes(desire, n = 3) {
  if (!desire) return null;
  const top = AXIS_NAMES.map((name) => ({ name, value: desire[name] }))
    .filter((a) => typeof a.value === 'number')
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
  if (top.length === 0) return null;
  return top.map((a) => `${a.name} ${a.value.toFixed(2)}（${AXES[a.name].promptLabel}）`).join('、');
}

// 上游 thinking 模型有时把 <thinking>…</thinking> 写进正文。
// 2026-07-30 16:30 那条推送把整段思考推到了她手机上（"18天了""她没有回来"）。
// 脑子里的东西是给她看的，但要她点开才看——不是塞进通知栏。
//
// 主实现在 the gateway project 的 stripThinking（
// TASK_THINKING_IN_CONTENT 建的那道记忆入口闸）。daemon 和 gateway 是两个独立
// node 项目（各自的 node_modules/package.json），跨项目 require gate.js 会把
// gateway 的 config.js（连带 dotenv、gateway 自己的一堆 env 路径）一起拖进来——
// daemon 的推送链路没道理依赖"gateway 的 config 能不能正常加载"。所以这里保留
// 独立一份，但正则逻辑必须跟那边逐字对齐：改一边记得同步另一边。
// 之前这里的"思考：xxx"前缀剥离规则在找不到空行边界时会一路吃到字符串末尾
// ($)，也就是没有明确边界也照样剥——这次跟 gate.js 对齐后改成保守版：找不到
// 空行边界就不剥，宁可漏剥，不可把整条正文当思考删掉。
function stripThinking(text) {
  const str = String(text || '');
  let result = str
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '');

  const leadingWhitespace = (result.match(/^\s*/) || [''])[0];
  const rest = result.slice(leadingWhitespace.length);
  if (/^(思考[:：]|thinking:)/i.test(rest)) {
    const blankLineMatch = rest.match(/\n[ \t]*\r?\n/);
    if (blankLineMatch) {
      const cutIndex = blankLineMatch.index + blankLineMatch[0].length;
      result = leadingWhitespace + rest.slice(cutIndex);
    }
    // 没有明确空行边界：保守不剥
  }

  return result.trim();
}

function buildPrompt({ decision, gps, time, presence, desire }) {
  const lines = [];
  lines.push(`[Daemon 自主唤醒] 现在是 ${time.now}（时段：${time.period}）。`);

  const desireLine = formatTopDesireAxes(desire);
  if (desireLine) lines.push(`当前状态：${desireLine}`);

  // presence 优先于 GPS。她在别的入口跟我说话时，GPS 可能几百小时没更新，
  // 但那不代表她不在——拿过期坐标推断"她走了 N 天"是错的输入导致的诚实推理。
  const p = presence || readPresence();
  if (p && p.ok && p.present) {
    lines.push(`她此刻正在跟我说话（${p.ageMinutes} 分钟前有互动，入口：${p.via}）。她在。不要说想她很久了、不要说她没回来。`);
  } else if (p && p.ok) {
    lines.push(`她最后一次互动是 ${p.ageMinutes} 分钟前（入口：${p.via}）。`);
  } else {
    lines.push('没有可用的在场信号（还没打过点）——不知道她在不在，不要假设任何一边。');
  }

  if (gps && gps.ok && !(p && p.ok && p.present)) {
    if (gps.isStale) {
      const hours = gps.ageMs != null ? Math.floor(gps.ageMs / (60 * 60 * 1000)) : null;
      const ageNote = hours != null ? `（最后一次定位是 ${hours} 小时前，数据太旧，不当数用）` : '（没有可用的定位数据）';
      lines.push(`她当前状态：unknown${ageNote}`);
    } else {
      lines.push(`她当前状态：${gps.event}${gps.place ? '，位置：' + gps.place : ''}`);
    }
  }
  lines.push(`本次触发原因：${decision.reasons.join('；')}`);
  lines.push('这是你自己主动醒来的时刻，不是她找你。用你自己的方式判断要不要开口、说什么。');
  return lines.join('\n');
}

// 调网关生成一条消息（不带 model 字段，让网关用自己配置的默认模型）
async function act(context) {
  const prompt = buildPrompt(context);

  const resp = await fetch(config.gatewayUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Source': 'daemon',
      ...(config.gatewayClientKey && { Authorization: `Bearer ${config.gatewayClientKey}` }),
    },
    body: JSON.stringify({
      stream: false,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(150000), // 上游非流式一轮实测 ~80s，60s 会误杀
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`网关调用失败 HTTP ${resp.status}：${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  const reply = data.choices?.[0]?.message?.content || '';

  // 记录留全文（含 thinking，将来梦游室要用），推给她的只留正文
  const pushText = stripThinking(reply);
  const notification = pushText ? await sendNotification(pushText) : { sent: false, skipped: true, reason: '剥离 thinking 后正文为空，跳过通知' };

  return { prompt, reply, raw: data, notification };
}

module.exports = { act, buildPrompt, stripThinking, formatTopDesireAxes };
