// TEST FIXTURE ONLY: runs the protocol test server as a standalone process so
// the n8n end-to-end run can point NVIDIA_BASE_URL at it.
import { NimTestServer } from './nimTestServer.ts';
import { createScript } from './scriptedAgents.ts';
import http from 'node:http';

const port = Number(process.env.NIM_TEST_PORT ?? 18555);
const nim = new NimTestServer();
const reply = createScript({ rejectFirstBuild: true, rejectFirstQa: true, visualDefectAfterTriage: true });
nim.behaviour = (call) => ({ reply: reply(call.body), delayMs: 150 + Math.floor(Math.random() * 350) });
nim.catalog = [];
const url = await nim.start();
// Re-expose on a fixed port via a tiny proxy so other processes can find it.
const target = new URL(url);
http.createServer((req, res) => {
  const p = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  req.pipe(p);
}).listen(port, '127.0.0.1', () => console.log(`NIM protocol test server on http://127.0.0.1:${port}/v1 (calls logged below)`));
setInterval(() => console.log(JSON.stringify({ calls: nim.calls.length, by_key: nim.callsByKey() })), 10_000);
