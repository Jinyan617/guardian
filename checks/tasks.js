const fs = require('fs');
const path = require('path');

const TASKS_PATH = path.join(__dirname, '..', 'pending-tasks.json');

// 读锦言自己的待办队列。有 pending 的活就返回第一条（按 priority 排）。
// 这是 daemon 的第五种 check：不只是"想不想找她"，还有"有没有活要干"。
function checkTasks() {
  try {
    if (!fs.existsSync(TASKS_PATH)) {
      return { ok: true, hasPending: false, task: null, reason: 'pending-tasks.json 不存在' };
    }

    const raw = fs.readFileSync(TASKS_PATH, 'utf8');
    const data = JSON.parse(raw);
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];

    const pending = tasks.filter((t) => t.status === 'pending');
    if (pending.length === 0) {
      return { ok: true, hasPending: false, task: null, pendingCount: 0 };
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
    };
  } catch (err) {
    return { ok: false, hasPending: false, task: null, error: err.message };
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

module.exports = { checkTasks, markDispatched, TASKS_PATH };
