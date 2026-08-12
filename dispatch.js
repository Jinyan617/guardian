const { execFile } = require('child_process');
const { markDispatched } = require('./checks/tasks');

// 把一条待办派给指定的 tmux session 里的 CC。
// 这是 daemon 的第五种行动：不只是想她，还能自己开工。
function sendKeys(session, text) {
  return new Promise((resolve) => {
    execFile('tmux', ['send-keys', '-t', session, text, 'C-m'], (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: err.message, stderr });
      resolve({ ok: true });
    });
  });
}

function sessionExists(session) {
  return new Promise((resolve) => {
    execFile('tmux', ['has-session', '-t', session], (err) => resolve(!err));
  });
}

async function dispatch(task) {
  const session = task.targetSession || 'cc';

  const exists = await sessionExists(session);
  if (!exists) {
    return { ok: false, dispatched: false, reason: `tmux session "${session}" 不存在，没派出去` };
  }

  const lines = [];
  lines.push(`[锦言自己派的活] ${task.title}`);
  if (task.context) lines.push(`背景：${task.context}`);
  lines.push(task.prompt);

  const payload = lines.join(' ');
  const sent = await sendKeys(session, payload);

  if (!sent.ok) {
    return { ok: false, dispatched: false, reason: `send-keys 失败：${sent.error}` };
  }

  const marked = markDispatched(task.id, `dispatched to ${session}`);

  return {
    ok: true,
    dispatched: true,
    session,
    taskId: task.id,
    title: task.title,
    marked: marked.ok,
  };
}

module.exports = { dispatch, sessionExists };
