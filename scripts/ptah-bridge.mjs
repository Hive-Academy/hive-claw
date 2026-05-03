#!/usr/bin/env node
/**
 * ptah-bridge — host-side HTTP server that runs ptah-cli on the host on
 * behalf of the openclaw-control daemon running inside the container.
 *
 * Why this exists
 * ---------------
 * ptah-cli's settings include `authMethod: claudeCli`, which means ptah shells
 * out to the `claude` binary for inference. The host has Claude CLI installed
 * and authenticated; the container does not. Rather than duplicate the binary
 * + auth state into the container, the daemon delegates orchestration runs
 * to this bridge, which spawns ptah on the host where everything already works.
 *
 * Path translation
 * ----------------
 * The daemon thinks in container paths (e.g. /home/agent/.openclaw/workspace/foo).
 * The bridge translates them to host paths before invoking ptah. Configure via:
 *   BRIDGE_WORKSPACE_CONTAINER  default /home/agent/.openclaw/workspace
 *   BRIDGE_WORKSPACE_HOST       default ${HOME}/projects
 *   BRIDGE_SPECS_CONTAINER      default /home/agent/.claude/shared-specs
 *   BRIDGE_SPECS_HOST           default ${HOME}/.claude/shared-specs
 *
 * Auth
 * ----
 * Requires Authorization: Bearer ${OPENCLAW_INTERNAL_TOKEN}, the same token
 * the bot-bridge already uses to call the daemon. Make sure both env vars
 * point at the same value.
 *
 * Endpoints
 * ---------
 * GET  /health   → { ok, ptahVersion, hostUser }
 * POST /invoke   → streams ptah's NDJSON; trailing line is the bridge envelope
 *                  { "_bridge": "done", "exitCode": <n>, "stderr": "...",
 *                    "durationMs": <n>, "translatedCwd": "...", "translations": <n> }
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const PORT = Number(process.env.PTAH_BRIDGE_PORT ?? 8744);
const HOST = process.env.PTAH_BRIDGE_HOST ?? '127.0.0.1';
const TOKEN = process.env.OPENCLAW_INTERNAL_TOKEN ?? '';
const PTAH_BIN = process.env.PTAH_BIN ?? 'ptah';

const HOME = os.homedir();
const WS_C = (process.env.BRIDGE_WORKSPACE_CONTAINER ?? '/home/agent/.openclaw/workspace').replace(/\/$/, '');
const WS_H = (process.env.BRIDGE_WORKSPACE_HOST ?? path.join(HOME, 'projects')).replace(/\/$/, '');
const SP_C = (process.env.BRIDGE_SPECS_CONTAINER ?? '/home/agent/.claude/shared-specs').replace(/\/$/, '');
const SP_H = (process.env.BRIDGE_SPECS_HOST ?? path.join(HOME, '.claude', 'shared-specs')).replace(/\/$/, '');

if (!TOKEN) {
  console.error('[ptah-bridge] FATAL: OPENCLAW_INTERNAL_TOKEN is unset. Bridge would accept any caller.');
  process.exit(1);
}

function translatePath(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return p;
  if (p === WS_C || p.startsWith(WS_C + '/')) return WS_H + p.slice(WS_C.length);
  if (p === SP_C || p.startsWith(SP_C + '/')) return SP_H + p.slice(SP_C.length);
  return p;
}

function translatePrompt(prompt) {
  if (typeof prompt !== 'string') return { text: prompt, count: 0 };
  let count = 0;
  // Regex covers both prefixes; rewrite each occurrence.
  const out = prompt
    .replace(new RegExp(escapeRegex(WS_C), 'g'), () => { count++; return WS_H; })
    .replace(new RegExp(escapeRegex(SP_C), 'g'), () => { count++; return SP_H; });
  return { text: out, count };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function authOk(req) {
  const h = req.headers['authorization'];
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return false;
  const presented = h.slice('Bearer '.length).trim();
  // Constant-time-ish compare.
  if (presented.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) diff |= presented.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return diff === 0;
}

function jsonResponse(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': buf.length,
  });
  res.end(buf);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function getPtahVersion() {
  try { return execSync(`${PTAH_BIN} --version`, { encoding: 'utf8', timeout: 3000 }).trim(); }
  catch { return null; }
}

async function handleInvoke(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return jsonResponse(res, 400, { error: 'invalid json', detail: String(e?.message ?? e) }); }

  const { cwd, prompt, taskId, agentId, profile, autoApprove, configFile } = body ?? {};
  if (typeof cwd !== 'string' || typeof prompt !== 'string') {
    return jsonResponse(res, 400, { error: 'cwd and prompt are required strings' });
  }

  const hostCwd = translatePath(cwd);
  const { text: hostPrompt, count: translations } = translatePrompt(prompt);

  const args = ['--json', '--cwd', hostCwd];
  // TASK_2026_002 B6: forward per-agent ptah scope (settings.json) to the
  // ptah CLI as `--config <translated>`. configFile is host-side already
  // (the daemon emits paths under ${OPENCLAW_HOST_HOME}/.ptah/...) and the
  // bind-mount is identity-mapped, so translatePath is effectively a
  // passthrough — but we still call it so a future config dir under the
  // workspace tree (test paths, etc.) gets re-rooted correctly.
  if (typeof configFile === 'string' && configFile.length > 0) {
    args.push('--config', translatePath(configFile));
  }
  if (autoApprove !== false) args.push('--auto-approve');
  args.push('session', 'start', '--profile', String(profile ?? 'claude_code'), '--task', hostPrompt);

  res.writeHead(200, {
    'content-type': 'application/x-ndjson',
    'cache-control': 'no-cache',
  });

  const started = Date.now();
  let stderr = '';

  const child = spawn(PTAH_BIN, args, {
    cwd: hostCwd,
    env: {
      ...process.env,
      OPENCLAW_TASK_ID: String(taskId ?? ''),
      OPENCLAW_AGENT_ID: String(agentId ?? ''),
    },
  });

  // ptah emits NDJSON on stdout; pipe directly through.
  child.stdout.on('data', (b) => {
    res.write(b);
  });
  child.stderr.on('data', (b) => {
    stderr += b.toString();
  });
  child.on('error', (err) => {
    const env = JSON.stringify({
      _bridge: 'done',
      exitCode: null,
      stderr: stderr + '\n' + err.message,
      durationMs: Date.now() - started,
      translatedCwd: hostCwd,
      translations,
      error: err.message,
    });
    res.end(env + '\n');
  });
  child.on('close', (code) => {
    const env = JSON.stringify({
      _bridge: 'done',
      exitCode: code,
      stderr,
      durationMs: Date.now() - started,
      translatedCwd: hostCwd,
      translations,
    });
    res.end(env + '\n');
  });

  // If the daemon disconnects, kill the ptah subprocess.
  res.on('close', () => {
    if (child.exitCode === null) {
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref();
    }
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    // TASK_2026_002 B6: surface ~/.ptah/{,plugins} existence so the daemon
    // can sanity-check the bind-mount before spawning. Both should be true
    // in a healthy install (entrypoint.sh mkdir -p's them).
    const PTAH_HOME = path.join(HOME, '.ptah');
    return jsonResponse(res, 200, {
      ok: true,
      ptahVersion: getPtahVersion(),
      hostUser: os.userInfo().username,
      pathMap: { workspace: { container: WS_C, host: WS_H }, specs: { container: SP_C, host: SP_H } },
      ptahConfigDirExists: existsSync(PTAH_HOME),
      ptahPluginsDirExists: existsSync(path.join(PTAH_HOME, 'plugins')),
    });
  }

  if (!authOk(req)) {
    return jsonResponse(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'POST' && req.url === '/invoke') {
    return handleInvoke(req, res);
  }

  jsonResponse(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  const v = getPtahVersion();
  console.log(`[ptah-bridge] listening on http://${HOST}:${PORT}`);
  console.log(`[ptah-bridge] ptah version: ${v ?? 'NOT FOUND on PATH — bridge will reject /invoke'}`);
  console.log(`[ptah-bridge] path map:`);
  console.log(`[ptah-bridge]   workspace: ${WS_C} → ${WS_H}`);
  console.log(`[ptah-bridge]   specs:     ${SP_C} → ${SP_H}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[ptah-bridge] received ${sig}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
