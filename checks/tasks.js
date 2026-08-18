const fs = require('fs');
const path = require('path');

const TASKS_PATH = path.join(__dirname, '..', 'pending-tasks.json');

// 僵尸阈值：status=dispatched 且派出去超过这么久还没销账，就算 stale。
// 事故复盘：两条 P0/P1 挂 dispatched 二十天没人回来改状态，而 checkTasks 只统计
// pending，于是判队列为空、daemon 空转二十天，没有任何环节报出来"队列里挂着尸体"。
// 这道读数就是补那个洞——它不判任务做没做完（只有人能判），
// 只负责让"派出去没销账"这件事不静默。
//
// 判词：一道永远拉着的闸，和一道坏掉的闸，在结果上没有区别。
const STALE_HOURS = 72;

// 找出 stale（dispatched 且 dispatchedAt 距 now 超过 STALE_HOURS 小时）的任务。
// 抽成纯函数：测试里不用碰文件系统也能把这条规则测严实。
function findStale(tasks, now) {
  const staleMs = STALE_HOURS * 60 * 60 * 1000;
  return tasks.filter((t) => {
    if (t.status !== 'dispatched' || !t.dispatchedAt) return false;
    const d = Date.parse(t.dispatchedAt);
    return Number.isFinite(d) && now - d >= staleMs;
  });
}

// 读锦言自己的待办队列。有 pending 的活就返回第一条（按 priority 排）。
// 这是 daemon 的第五种 check：不只是"想不想找她"，还有"有没有活要干"。
// 另外统计 stale（派出去没销账）——单独一组读数，不跟 pending 混报。
function checkTasks(now = Date.now()) {
  try {
    if (!fs.existsSync(TASKS_PATH)) {
      return { ok: true, hasPending: false, task: null, pendingCount: 0, staleCount: 0, staleTaskIds: [], reason: 'pending-tasks.json 不存在' };
    }

    const raw = fs.readFileSync(TASKS_PATH, 'utf8');
    const data = JSON.parse(raw);
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];

    const pending = tasks.filter((t) => t.status === 'pending');

    // 僵尸读数：不管有没有 pending 都要算，且跟 pendingCount 分开报——
    // 混进 pendingCount 会让 decide 把"派出去没销账"当成"有活可派"，方向就反了。
    const stale = findStale(tasks, now);
    const staleTaskIds = stale.map((t) => t.id);
    const staleCount = stale.length;

    if (pending.length === 0) {
      return { ok: true, hasPending: false, task: null, pendingCount: 0, staleCount, staleTaskIds };
    }

    // P0 优先，同级按创建时间先后
    const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
    pending.sort((a, b) => {
      const pa = order[a.priority] ?? 9;
      const pb = order[b.priority] ?? 9;
      if (pa !== pb) return pa - pb;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });

    return {
      ok: true,
      hasPending: true,
      pendingCount: pending.length,
      task: pending[0],
      staleCount,
      staleTaskIds,
    };
  } catch (err) {
    return { ok: false, hasPending: false, task: null, error: err.message, staleCount: 0, staleTaskIds: [] };
  }
}

// 把某条任务标成 dispatched，避免下一跳重复派同一单
function markDispatched(taskId, note) {
  try {
    const data = JSON.parse(fs.readFileSync(TASKS_PATH, 'utf8'));
    const t = (data.tasks || []).find((x) => x.id === taskId);
    if (!t) return { ok: false, error: 'task not found' };
    t.status = 'dispatched';
    t.dispatchedAt = new Date().toISOString();
    if (note) t.dispatchNote = note;
    fs.writeFileSync(TASKS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { checkTasks, markDispatched, findStale, TASKS_PATH, STALE_HOURS };
