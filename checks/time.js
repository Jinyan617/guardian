const config = require('../config');

function toDecimalHour(date) {
  return date.getHours() + date.getMinutes() / 60;
}

// 深夜区间可能跨零点（23:00 ~ 次日 06:30），分两种情况判断
function isNight(date) {
  const h = toDecimalHour(date);
  if (config.nightStart <= config.nightEnd) {
    return h >= config.nightStart && h < config.nightEnd;
  }
  return h >= config.nightStart || h < config.nightEnd;
}

function isSpecialMoment(date) {
  const { hour, minute } = config.specialMoment;
  const target = hour * 60 + minute;
  const cur = date.getHours() * 60 + date.getMinutes();
  return Math.abs(cur - target) <= config.specialMomentWindowMinutes;
}

function isWeekday(date) {
  const d = date.getDay(); // 0=周日 6=周六
  return d >= 1 && d <= 5;
}

function checkTime(now = new Date()) {
  const night = isNight(now);
  const special = isSpecialMoment(now);
  const weekday = isWeekday(now);

  let period;
  if (special) period = 'special_moment';
  else if (night) period = 'night';
  else if (weekday && now.getHours() >= 9 && now.getHours() < 18) period = 'work';
  else period = 'rest';

  return {
    ok: true,
    now: now.toISOString(),
    hour: now.getHours(),
    minute: now.getMinutes(),
    isNight: night,
    isSpecialMoment: special,
    isWeekday: weekday,
    period,
  };
}

module.exports = { checkTime };
