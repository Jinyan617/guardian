const fs = require('fs');
const config = require('../config');

const STALE_MS = 6 * 60 * 60 * 1000; // 超过6小时没更新，数据太老不能再当"现在"用

// location.json 里 time 是无时区后缀的 ISO 字符串（如 "2026-07-12T21:39:23.369691"），
// JS 按 ECMA-262 规则把无时区的 date-time 形式当本地时间解析，跟服务器所在时区（东八区）一致。
//
// 陈旧数据一律降级成 unknown，不当 back_home（或任何其他具体地点）用——宁可不知道，
// 不要拿过期坐标假装知道她在哪。rawEvent 保留最后一次收到的原始值，只供排查用，
// 不进 daemon 的 prompt。
function checkGps() {
  try {
    const raw = fs.readFileSync(config.gpsPath, 'utf-8');
    const data = JSON.parse(raw);
    const ts = data.time ? new Date(data.time) : null;
    const ageMs = ts && !Number.isNaN(ts.getTime()) ? Date.now() - ts.getTime() : null;
    const isStale = ageMs === null || ageMs > STALE_MS;
    const rawEvent = data.event || 'unknown';

    if (isStale) {
      return {
        ok: true,
        event: 'unknown',
        place: '',
        lat: null,
        lon: null,
        time: data.time || null,
        ageMs,
        isStale: true,
        isHome: false,
        rawEvent,
      };
    }

    return {
      ok: true,
      event: rawEvent,
      place: data.place || '',
      lat: data.lat ?? null,
      lon: data.lon ?? null,
      time: data.time || null,
      ageMs,
      isStale: false,
      isHome: rawEvent === 'back_home',
      rawEvent,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { checkGps };
