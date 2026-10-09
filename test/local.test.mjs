import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
// Resolve a local development host first, then npm's global installation.
// No installation, credentials, sessions, providers or panes. An explicit override is authoritative.
function resolveHost() {
 if (process.env.PI_TEST_HOST) return resolve(process.env.PI_TEST_HOST);
 const localRequire = createRequire(import.meta.url);
 try { return resolve(dirname(localRequire.resolve('@earendil-works/pi-coding-agent')), '..'); }
 catch {
  try {
   const globalRoot = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8' }).trim();
   return resolve(globalRoot, '@earendil-works/pi-coding-agent');
  } catch { throw Error('Install Pi >=1.1.0 or set PI_TEST_HOST to its package directory'); }
 }
}
const host = resolveHost();
const require = createRequire(`${host}/package.json`);
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  '@earendil-works/pi-coding-agent': `${host}/dist/index.js`,
  'typebox': require.resolve('typebox'),
} });
const { registerBtwExtension, decideCacheMode } = await jiti.import('../index.ts');
const { createPayload, buildAgentStartArgs } = await jiti.import('../src/core.ts');
const { DEFAULT_CONFIG } = await jiti.import('../src/config.ts');
const { buildMergeTranscript } = await jiti.import('../src/merge.ts');
const { ExtensionRunner } = await import(pathToFileURL(`${host}/dist/core/extensions/runner.js`));
const sys = text => ({ role: 'system', content: text, timestamp: 0 });
const user = text => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 0 });
const parent = [sys('PRIVATE_SYSTEM'), user('PRIVATE_PARENT'), sys('PRIVATE_DELTA')];
function payload(config = {}) { return createPayload({ createdAt: '', parentSessionId: 'parent-id', parentPaneId: null,
 metadata: { generatedAt: '', cwd: '', session: '', model: 'test/model' }, parentSystemPrompt: 'PRIVATE_SYSTEM',
 parentActiveTools: ['read', 'bash'], parentThinkingLevel: 'high', messages: parent, draftQuestion: '', config: { ...DEFAULT_CONFIG, ...config } }); }
async function setup(p = payload(), tools = ['bash', 'read'], registered = ['read', 'bash']) {
 const handlers = new Map(), commands = new Map(), notes = []; let active = tools, sets = 0;
 const pi = { on: (name, fn) => handlers.set(name, [fn]), registerCommand: (name, cmd) => commands.set(name, cmd),
 getActiveTools: () => active, getAllTools: () => registered.map(tool => typeof tool === 'string' ? ({ name: tool, exposure: 'direct' }) : tool),
 setActiveTools: names => { sets++; active = [...names]; }, getThinkingLevel: () => 'high', events: { emit() {} },
 exec() { throw Error('Must not spawn'); } };
 const ctx = { model: { provider: 'test', id: 'model', api: 'openai-responses' }, sessionManager: { getSessionId: () => 'child-id' },
 ui: { setWidget() {}, notify: text => notes.push(text) } };
 const old = process.env.PI_HERDR_BTW_PAYLOAD; process.env.PI_HERDR_BTW_PAYLOAD = '/mock/payload';
 try { await registerBtwExtension(pi, { store: { read: async () => p } }); }
 finally { if (old === undefined) delete process.env.PI_HERDR_BTW_PAYLOAD; else process.env.PI_HERDR_BTW_PAYLOAD = old; }
 const run = (name, event = {}) => handlers.get(name)?.[0](event, ctx);
 const runner = new ExtensionRunner([{ path: 'mock', handlers }], {}, '', {}, {});
 runner.createContext = () => ctx;
 return { pi, ctx, run, runner, notes, sets: () => sets, check: () => commands.get('btw').handler('check', ctx) };
}
test('native: actual Pi runner preserves parent deltas, removes child bootstrap, keeps followups', async () => {
 const s = await setup();
 assert.equal(s.run('before_agent_start', { systemPrompt: 'child' }), undefined);
 assert.equal(s.sets(), 1); assert.deepEqual(s.pi.getActiveTools(), ['read', 'bash']);
 assert.equal(s.run('context'), undefined);
 const child = [sys('child bootstrap'), sys('child tool bootstrap'), user('question'), sys('child later delta'), user('followup')];
 const output = await s.runner.emitContext(child);
 assert.deepEqual(output.slice(0, 3), parent);
 assert.equal(output.filter(m => m.role === 'system').length, 3);
 assert.deepEqual(output.slice(4), child.slice(2));
 assert.equal((await s.runner.emitContext(child)).length, output.length); // no accumulated injection
 assert.equal(buildMergeTranscript(child).includes('PRIVATE_PARENT'), false);
 await s.check(); assert.match(s.notes[0], /Context mode: native/); assert.doesNotMatch(s.notes[0], /PRIVATE_/);
 s.pi.setActiveTools(['read']); s.run('before_agent_start', { systemPrompt: 'child' });
 assert.equal(s.sets(), 2); // only our explicit user change; restoration never repeats
 await s.check(); assert.match(s.notes.at(-1), /Context mode: fallback/);
});
test('missing registered tools blocks restoration and gives concrete fallback/diff', async () => {
 const s = await setup(payload(), ['read'], ['read']);
 assert.ok(s.run('before_agent_start', { systemPrompt: 'child' }).systemPrompt);
 assert.equal(s.sets(), 0);
 const result = await s.runner.emitContext([sys('child'), user('question'), user('followup')]);
 assert.equal(result[0].content, 'child'); assert.equal(result.filter(m => m.role === 'system').length, 1);
 assert.deepEqual(result.slice(2), [user('question'), user('followup')]);
 await s.check(); assert.match(s.notes[0], /blocked: unregistered \[bash\]/); assert.match(s.notes[0], /Missing active: bash/);
 assert.match(s.notes[0], /tool set or order differs/);
});
test('overrides and legacy transcript keep fallback', async () => {
 for (const config of [{ tools: 'none' }, { tools: 'read-only' }, { model: 'test/model' }, { thinking: 'high' }]) {
  const s = await setup(payload(config)); s.run('before_agent_start', { systemPrompt: 'child' });
  await s.check(); assert.match(s.notes[0], /Context mode: fallback/);
  if (config.tools) assert.equal(s.sets(), 0);
 }
 const p = payload(); p.messages = [user('legacy')];
 assert.match(decideCacheMode(p, { model: 'test/model', activeTools: ['read', 'bash'], thinkingLevel: 'high' }).reason, /legacy/);
});
test('sharing experiments remain independent of prefix verification and honor conflicts/kill switch', async () => {
 const s = await setup(payload({ shareKey: true, shareHeader: true })); s.run('before_agent_start', { systemPrompt: 'child' });
 const body = { model: 'model', input: [{ role: 'user', content: 'question' }], prompt_cache_key: 'child-id' };
 assert.equal(s.run('before_provider_request', { payload: body }).prompt_cache_key, 'parent-id');
 assert.equal(body.prompt_cache_key, 'child-id');
 const headers = {}; s.run('before_provider_headers', { headers }); assert.equal(headers.session_id, 'parent-id');
 await s.check(); assert.match(s.notes.at(-1), /no parent baseline/); assert.match(s.notes.at(-1), /Shared: key\+header/);
 const conflict = { 'Session-ID': 'other' }; s.run('before_provider_headers', { headers: conflict }); assert.equal(conflict.session_id, undefined);
 await s.check(); assert.match(s.notes.at(-1), /header conflict/);
 const old = process.env.PI_HERDR_BTW_SHARE_CACHE_KEY; process.env.PI_HERDR_BTW_SHARE_CACHE_KEY = '0';
 try { assert.equal(s.run('before_provider_request', { payload: body }), undefined); const h = {}; s.run('before_provider_headers', { headers: h }); assert.deepEqual(h, {}); }
 finally { if (old === undefined) delete process.env.PI_HERDR_BTW_SHARE_CACHE_KEY; else process.env.PI_HERDR_BTW_SHARE_CACHE_KEY = old; }
});
test('check before first run reports current diff without restoring tools', async () => {
 const s = await setup(); await s.check(); assert.equal(s.sets(), 0);
 assert.match(s.notes[0], /pre-run; restoration pending/); assert.match(s.notes[0], /Tool order: different/);
});
test('actual AgentSession forced projection does not collapse native replay', async () => {
 const { AgentSession } = await import(pathToFileURL(`${host}/dist/core/agent-session.js`));
 const s = await setup(); const before = s.run('before_agent_start', { systemPrompt: 'child' });
 const shell = { agent: { transformContext: messages => s.runner.emitContext(messages) },
 _runSystemPromptOptions: { forceSystemPrompt: before?.systemPrompt } };
 AgentSession.prototype._installAgentForcedPromptProjection.call(shell);
 const output = await shell.agent.transformContext([sys('child'), user('question'), user('followup')]);
 assert.deepEqual(output.slice(0, 3), parent); assert.equal(output[0].role, 'system');
 assert.equal(output.at(-1).content[0].text, 'followup');
});
test('fallback never shares hints; bad integrity blocks input', async () => {
 const s = await setup(payload({ shareKey: true, shareHeader: true, tools: 'none' }));
 s.run('before_agent_start', { systemPrompt: 'child' });
 assert.equal(s.run('before_provider_request', { payload: { prompt_cache_key: 'child-id' } }), undefined);
 const headers = {}; s.run('before_provider_headers', { headers }); assert.deepEqual(headers, {});
 const p = payload(); p.messages = [...p.messages, user('tampered')]; const bad = await setup(p);
 assert.deepEqual(bad.run('input'), { action: 'handled' }); assert.match(bad.notes[0], /integrity check failed/);
});

test('actual discovery matches Pi CLI builtins, honors disabled resources and auto-name denylist', async () => {
 const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
 const { tmpdir } = await import('node:os');
 const { discoverChildExtensions, loadChildExtensions, CLI_BUILTIN_EXTENSIONS } = await jiti.import('../src/child-extensions.ts');
 const { builtInExtensions } = await import(pathToFileURL(`${host}/dist/extensions/index.js`));
 const { DefaultResourceLoader } = await import(pathToFileURL(`${host}/dist/core/resource-loader.js`));
 const root = await mkdtemp(resolve(tmpdir(), 'btw-discovery-'));
 try {
  const cwd = resolve(root, 'project'), agentDir = resolve(root, 'agent');
  await mkdir(cwd); await mkdir(resolve(agentDir, 'extensions'), { recursive: true });
  await writeFile(resolve(agentDir, 'extensions/auto-name.ts'), 'export default function() {}');
  await writeFile(resolve(agentDir, 'settings.json'), JSON.stringify({ extensions: ['-builtin:mcp'] }));
  assert.deepEqual([...CLI_BUILTIN_EXTENSIONS].sort(), builtInExtensions.map(e => e.name).sort());
  const candidates = await discoverChildExtensions({ cwd, agentDir });
  assert.ok(candidates.some(c => c.path === 'builtin:codemode' && c.names.includes('codemode')));
  assert.ok(!candidates.some(c => c.path === 'builtin:mcp'));
  const policy = resolve(root, 'policy.json');
  await writeFile(policy, JSON.stringify({ mode: 'denylist', denylist: ['auto-name'] }));
  const paths = await loadChildExtensions(policy, undefined, { cwd, agentDir });
  assert.ok(paths.includes('builtin:codemode')); assert.ok(!paths.some(p => p.endsWith('/auto-name.ts')));
  assert.ok(!paths.includes('builtin:mcp'));
  const { parseArgs } = await import(pathToFileURL(`${host}/dist/cli/args.js`));
  const tools = ['read', 'codemode', 'web_search', 'fetch_content', 'web_enable'];
  const argv = buildAgentStartArgs({ childExtensions: paths, paneName: 'test', model: 'test/model',
   thinkingLevel: 'high', toolMode: 'inherit', activeTools: tools }, 'test-pane');
  const parsed = parseArgs(argv.slice(argv.indexOf('--') + 1));
  assert.equal(parsed.noExtensions, true); assert.ok(parsed.extensions.includes('builtin:codemode'));
  assert.deepEqual(parsed.tools, tools); assert.equal(parsed.noSession, true);
  // Actual child resource pipeline: --no-extensions plus explicit -e builtin selectors.
  // Only factories load; no sessions bind, MCP connections, model requests or panes.
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true,
   additionalExtensionPaths: paths.filter(p => p.startsWith('builtin:')), extensionFactories: builtInExtensions,
   noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const extensions = loader.getExtensions().extensions;
  assert.ok(extensions.some(e => e.path === 'builtin:codemode' && e.tools.has('codemode')));
  assert.ok(!extensions.some(e => e.path === 'builtin:mcp'));
  await writeFile(policy, JSON.stringify({ mode: 'allowlist', allowlist: ['codemode'] }));
  const only = await loadChildExtensions(policy, undefined, { cwd, agentDir });
  assert.equal(only.length, 2); assert.ok(only.includes('builtin:codemode'));
 } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed web_enable uses normal registered tools, activates only configured capabilities without I/O',
 { skip: process.env.PI_TEST_WEB ? false : 'Set PI_TEST_WEB to an installed pi-web-access tool-activation.ts' }, async () => {
 const webPath = resolve(process.env.PI_TEST_WEB);
 const { registerWebToolActivation } = await jiti.import(webPath);
 const handlers = new Map(), definitions = new Map(); let active = ['read', 'web_search', 'fetch_content'];
 for (const name of active) definitions.set(name, { name, exposure: 'direct' });
 const pi = { on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list);
  return () => list.splice(list.indexOf(fn), 1); }, registerTool(t) { definitions.set(t.name, t); },
  getAllTools: () => [...definitions.values()], getActiveTools: () => active,
  setActiveTools: names => { active = names.filter(n => definitions.has(n)); } };
 registerWebToolActivation(pi, [{ name: 'web_search', capability: 'search' }, { name: 'fetch_content', capability: 'fetch' }], 'dynamic');
 const ctx = { sessionManager: { getBranch: () => [] }, model: { api: 'openai-responses' } };
 for (const fn of handlers.get('session_start')) await fn({}, ctx);
 assert.deepEqual(active, ['read', 'web_enable']);
 assert.ok(pi.getAllTools().some(t => t.name === 'web_search' && t.exposure !== 'hidden'));
 const result = await definitions.get('web_enable').execute();
 assert.equal(result.isError, undefined); assert.deepEqual(result.details.enabled, ['web_search', 'fetch_content']);
 assert.ok(!active.includes('source_check')); // disabled/unregistered capability stays absent
 // BTW selects the exact parent subset via the same supported Pi API, not web_enable's broad enable-all.
 const p = payload(); p.parentActiveTools = ['read', 'codemode', 'fetch_content', 'web_enable'];
 const s = await setup(p, ['read', 'web_enable'], ['read', 'codemode', ...pi.getAllTools()]);
 assert.equal(s.run('before_agent_start', { systemPrompt: 'child' }), undefined);
 assert.deepEqual(s.pi.getActiveTools(), p.parentActiveTools);
 assert.ok(!s.pi.getActiveTools().includes('web_search'));
 await s.check(); assert.match(s.notes[0], /restored exact parent loadout/);
});

test('hidden tools never activated even when every other parent tool is registered', async () => {
 const s = await setup(payload(), ['read'], ['read', { name: 'bash', exposure: 'hidden' }]);
 s.run('before_agent_start', { systemPrompt: 'child' }); assert.equal(s.sets(), 0);
 await s.check(); assert.match(s.notes[0], /blocked: hidden \[bash\]/);
});
