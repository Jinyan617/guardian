const { execFileSync } = require('child_process');
const config = require('../config');

function isActive(serviceName) {
  try {
    const out = execFileSync('systemctl', ['is-active', serviceName], { encoding: 'utf-8' }).trim();
    return out === 'active';
  } catch (err) {
    // systemctl is-active 在非 active 状态下会以非零码退出，stdout 里仍带着状态字符串
    const out = (err.stdout || '').toString().trim();
    return out === 'active';
  }
}

async function checkGatewayHttp() {
  try {
    const resp = await fetch(config.gatewayHealthUrl, { signal: AbortSignal.timeout(5000) });
    return resp.ok;
  } catch {
    return false;
  }
}

// 纯函数：给定"谁活着"的状态表，按每条服务自己的 expect 算出该报警的 down 列表。
// expect==='ignore' 的服务哪怕不 active 也不算 down——它可能是故意停的（feedling、
// 以后的 Echo）。拆成纯函数是为了不用真的调 systemctl 也能把这条规则测严实。
function computeDown(services, activeByName) {
  return services
    .filter((svc) => (svc.expect ?? 'running') === 'running' && !activeByName[svc.name])
    .map((svc) => svc.name);
}

async function checkServices() {
  const results = {};
  for (const svc of config.services) {
    results[svc.name] = isActive(svc.name);
  }
  results['gateway.service(http)'] = await checkGatewayHttp();

  const allChecked = [...config.services, { name: 'gateway.service(http)', expect: 'running' }];
  const down = computeDown(allChecked, results);

  return { ok: down.length === 0, results, down };
}

module.exports = { checkServices, computeDown };
