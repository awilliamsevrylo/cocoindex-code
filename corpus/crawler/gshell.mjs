#!/usr/bin/env node
// Direct caller for gcloud-ssh-mcp shell_exec (no MCP client in the path).
// Endpoint + auth come from ~/.local/state/gcloud-ssh-mcp.json (Access pair +
// bearer). Warm lane = `singleton`: same account, container and DO every call.
// Keepalive: the lane's DO pings the VM every 60 s for 30 min after the last
// call, so a call at least every ~25 min keeps the VM (and a nohup job) alive.
// Usage: node gshell.mjs <singleton> <image> <cmdfile|-> [timeoutMs]
//        node gshell.mjs <singleton> <image> --keepalive <minutes>
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const cred = JSON.parse(readFileSync(`${homedir()}/.local/state/gcloud-ssh-mcp.json`, 'utf8'));
const [singleton, image, src, arg4] = process.argv.slice(2);
if (!singleton || !image || !src) { console.error('usage: gshell.mjs <singleton> <image> <cmdfile|-|--keepalive N> [timeoutMs]'); process.exit(2); }

export async function shellExec(command, timeoutMs = 300000) {
  const res = await fetch(cred.url, {
    method: 'POST',
    headers: { ...cred.headers, 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'shell_exec' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
      params: { name: 'shell_exec', arguments: { command, singleton, image, timeoutMs } } }),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`); }
  if (j.error) throw new Error(`rpc error ${j.error.code}: ${j.error.message}`);
  return (j.result?.content || []).map((c) => c.text).join('\n');
}

if (src === '--keepalive') {
  const minutes = Number(arg4 || 600);
  const end = Date.now() + minutes * 60000;
  while (Date.now() < end) {
    try { console.log(new Date().toISOString(), (await shellExec('echo alive; uptime', 30000)).split('\n').slice(-1)[0]); }
    catch (e) { console.log(new Date().toISOString(), 'keepalive error', String(e.message).slice(0, 200)); }
    await new Promise((r) => setTimeout(r, 20 * 60000));
  }
} else {
  const command = src === '-' ? readFileSync(0, 'utf8') : readFileSync(src, 'utf8');
  console.log(await shellExec(command, Number(arg4 || 300000)));
}
