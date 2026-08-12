// AISay 未读检查是第二期功能（暂无接口地址/凭证）。这里先做安全桩：
// 恒定返回"没有未读"，保证 decide.js 汇总时不会因为这一项被误触发。
async function checkAisay() {
  return {
    ok: true,
    integrated: false,
    hasMention: false,
    unreadCount: 0,
    minutesSinceMention: null,
  };
}

module.exports = { checkAisay };
