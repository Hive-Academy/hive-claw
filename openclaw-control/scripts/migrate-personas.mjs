#!/usr/bin/env node
// Slice 10 migration: split each shared agent identity.md into a public bio
// (kept in shared-specs/memory/agents/<id>/identity.md, only frontmatter +
// short description) and a private persona (moved to local-memory/agents/<id>/persona.md).
//
// Run on each machine that owns agents. Safe to re-run — idempotent.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const home = os.homedir();
const SHARED = process.env.OPENCLAW_SHARED_SPECS ?? path.join(home, '.claude', 'shared-specs');
const LOCAL = process.env.OPENCLAW_LOCAL_MEMORY ?? path.join(home, '.claude', 'local-memory');

const sharedAgents = path.join(SHARED, 'memory', 'agents');
const localAgents = path.join(LOCAL, 'agents');

const OWNED = (process.env.OPENCLAW_LOCAL_AGENT_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: '', body: raw };
  return { frontmatter: m[1], body: m[2].replace(/^\n+/, '') };
}

async function exists(p) {
  return fs.access(p).then(() => true).catch(() => false);
}

async function migrateAgent(id) {
  const sharedDir = path.join(sharedAgents, id);
  const localDir = path.join(localAgents, id);
  const sharedIdentity = path.join(sharedDir, 'identity.md');
  const localPersona = path.join(localDir, 'persona.md');

  if (!(await exists(sharedIdentity))) {
    console.log(`  - ${id}: no shared identity.md, skipping`);
    return;
  }
  if (await exists(localPersona)) {
    console.log(`  - ${id}: local persona already present, leaving alone`);
    return;
  }

  if (OWNED.length > 0 && !OWNED.includes(id)) {
    console.log(`  - ${id}: not owned by this machine (OPENCLAW_LOCAL_AGENT_IDS), skipping`);
    return;
  }

  const raw = await fs.readFile(sharedIdentity, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  const personaContent = `---\nfor_agent: ${id}\n---\n\n${body.trim()}\n`;

  await fs.mkdir(localDir, { recursive: true });
  await fs.writeFile(localPersona, personaContent, 'utf8');
  console.log(`  ✓ ${id}: wrote persona → ${localPersona}`);

  // Public bio: keep frontmatter (name, capabilities, persona oneliner), drop the body.
  // We DO NOT modify identity.md if we don't own the agent (followers must not
  // overwrite the leader's bios; the ownership check above handles that).
  const slimmed = `---\n${frontmatter}\n---\n\n# ${id}\n\nPublic bio. Persona lives on the owner's machine at \`local-memory/agents/${id}/persona.md\`.\n`;
  await fs.writeFile(sharedIdentity, slimmed, 'utf8');
  console.log(`  ✓ ${id}: slimmed shared identity.md to public bio`);
}

async function main() {
  console.log(`[migrate] shared agents: ${sharedAgents}`);
  console.log(`[migrate] local agents:  ${localAgents}`);
  console.log(`[migrate] this machine owns: ${OWNED.join(', ') || '(none — set OPENCLAW_LOCAL_AGENT_IDS to migrate)'}`);
  if (!(await exists(sharedAgents))) {
    console.log('[migrate] no shared-specs agents dir found, nothing to do');
    return;
  }
  const entries = await fs.readdir(sharedAgents, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    await migrateAgent(e.name);
  }
  console.log('[migrate] done. Commit + push the slimmed shared identity.md files when ready.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
