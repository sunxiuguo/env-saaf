'use strict';
const assert = require('node:assert');
const { validateEnv, EnvSaafError, parseEnvFile, scanCode, diffEnv, maskSecrets, maskValue, generateExample } = require('./index');

// v0.1.0 core
const env = validateEnv({
  PORT: { type: 'port', required: true },
  DEBUG: { type: 'boolean', default: false },
  API_URL: { type: 'url', required: true },
}, { PORT: '3000', DEBUG: 'false', API_URL: 'https://example.com' });
assert.strictEqual(env.PORT + 1, 3001);
assert.strictEqual(env.DEBUG, false);
assert.throws(() => validateEnv({ A: { required: true } }, {}), EnvSaafError);

// v0.2.0
assert.deepStrictEqual(parseEnvFile('PORT=3000\nNAME="my app"\n'), { PORT: '3000', NAME: 'my app' });
assert.deepStrictEqual(scanCode('process.env.API_URL; const { PORT } = process.env;'), ['API_URL', 'PORT']);
assert.deepStrictEqual(diffEnv(['A', 'B'], ['A', 'C']), { usedNotDocumented: ['B'], documentedNotUsed: ['C'] });

// Issue #69: deterministic combinations of the documented .env syntax.
{
  let seed = 0x62a47f21;
  const pick = (choices) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return choices[Math.floor(seed / 0x100000000 * choices.length)];
  };
  const spaces = ['', ' ', '  ', '\t'];
  const fragments = ['sample', '42', 'x=y', 'with#hash', 'café', 'path\\part'];
  const noise = ['', '# comment', 'word without equals', '? = value', "UNCLOSED='", '??=', ' \\ '];

  for (let sample = 0; sample < 128; sample++) {
    const newline = pick(['\n', '\r\n']);
    const anchor = 'FUZZ_BASE_' + sample;
    const local = 'demo' + sample;
    const reference = '${' + anchor + '}';
    const expected = { [anchor]: local };
    const lines = [anchor + '=' + local];

    for (let index = 0; index < 8; index++) {
      const key = pick(['FUZZ_KEY_', '_FUZZ_', 'Case_']) + sample + '_' + index;
      const word = pick(fragments) + '-' + pick(fragments);
      const phrase = ' ' + word + ' # literal ';
      const [encoded, value] = pick([
        [word, word],
        ['"' + phrase + '"', phrase],
        ["'" + phrase + "'", phrase],
        ['"' + word + newline + 'next line"', word + '\nnext line'],
        [reference + '/suffix', local + '/suffix'],
        ['"' + reference + ' ' + word + '"', local + ' ' + word],
        ['\\' + reference, reference],
        ["'" + reference + "'", reference],
        ['', ''],
      ]);
      const prefix = pick(['', 'export ', 'export\t']);
      const comment = pick(['', ' # trailing', '\t# trailing']);
      lines.push(pick(spaces) + prefix + key + pick(spaces) + '=' + pick(spaces) + encoded + comment);
      expected[key] = value;
    }

    const valid = lines.join(newline) + newline;
    let parsed;
    assert.doesNotThrow(() => { parsed = parseEnvFile(valid); }, JSON.stringify(valid));
    assert.deepStrictEqual(parsed, expected, JSON.stringify(valid));

    const mixed = [pick(noise), ...lines.slice(0, 5), pick(noise), ...lines.slice(5), pick(noise)].join(newline);
    assert.doesNotThrow(() => parseEnvFile(mixed), JSON.stringify(mixed));
  }
}

// v1.0.0: masking — a real secret is never printed in full
assert.strictEqual(maskValue('sk_live_123456'), 'sk***56');
assert.strictEqual(maskValue('abc'), '****');
assert.deepStrictEqual(maskSecrets({ KEY: 'sk_live_123456' }), { KEY: 'sk***56' });
// v1.0.0: generateExample — placeholders/defaults only, never a real secret
const ex = generateExample({ PORT: { type: 'port', required: true }, API_KEY: { type: 'string', required: true } });
assert.ok(ex.includes('PORT=3000'));
assert.ok(ex.includes('API_KEY=your_value_here'));
assert.ok(!ex.includes('sk_live'));

// scanDir also scans .mts/.cts files
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { scanDir } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-scan-'));
  fs.writeFileSync(path.join(dir, 'a.mts'), 'export const x = process.env.FROM_MTS;');
  fs.writeFileSync(path.join(dir, 'b.cts'), 'export const y = process.env.FROM_CTS;');
  fs.writeFileSync(path.join(dir, 'c.ts'), 'export const z = process.env.FROM_TS;');
  assert.deepStrictEqual(scanDir(dir), ['FROM_CTS', 'FROM_MTS', 'FROM_TS']);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #14: parseEnvFile — strip inline comments after unquoted values;
// '#' inside quotes is safe; a comment after a quoted value is stripped too
{
  const { parseEnvFile, loadEnv } = require('./index');
  assert.deepStrictEqual(
    parseEnvFile('PORT=3000 # my port\nDEBUG=true # enable logs\nNAME="x # y"\nNOTE=\'a # b\' # trailing\nEMPTY= # nothing\nURL=https://example.com/#frag\n'),
    { PORT: '3000', DEBUG: 'true', NAME: 'x # y', NOTE: 'a # b', EMPTY: '', URL: 'https://example.com/#frag' }
  );
  // end-to-end: a .env file with inline comments validates via loadEnv
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-inline-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'PORT=4000 # app port\nDEBUG=true # verbose\n');
  const envInline = loadEnv(
    { PORT: { type: 'port', required: true }, DEBUG: { type: 'boolean', default: false } },
    { path: file, env: {} }
  );
  assert.strictEqual(envInline.PORT, 4000);
  assert.strictEqual(envInline.DEBUG, true);
  fs.rmSync(dir, { recursive: true, force: true });
}

// feat: loadEnv — read a .env file and validate it in one call (fixes #2)
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadEnv } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-loadenv-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'PORT=4000\nDEBUG=true\nAPI_URL=https://api.example.com/v1\n');
  const schema = {
    PORT: { type: 'port', required: true },
    DEBUG: { type: 'boolean', default: false },
    API_URL: { type: 'url', required: true },
  };
  // basic: file se typed values
  const env1 = loadEnv(schema, { path: file, env: {} });
  assert.strictEqual(env1.PORT, 4000);
  assert.strictEqual(env1.DEBUG, true);
  assert.strictEqual(env1.API_URL, 'https://api.example.com/v1');
  assert.ok(Object.isFrozen(env1));
  // override: false (default) — the base env wins; true — the file wins
  assert.strictEqual(loadEnv(schema, { path: file, env: { PORT: '5000' } }).PORT, 5000);
  assert.strictEqual(loadEnv(schema, { path: file, env: { PORT: '5000' }, override: true }).PORT, 4000);
  // assign: validated values are written back into the base env as strings
  const target = {};
  loadEnv(schema, { path: file, env: target, assign: true });
  assert.strictEqual(target.PORT, '4000');
  assert.strictEqual(target.DEBUG, 'true');
  // without assign, a process.env-like base env stays untouched
  const untouched = { PORT: '5000' };
  loadEnv(schema, { path: file, env: untouched });
  assert.strictEqual(untouched.PORT, '5000');
  assert.strictEqual(untouched.DEBUG, undefined);
  // missing file + required schema -> saaf error
  assert.throws(() => loadEnv(schema, { path: path.join(dir, 'nope.env'), env: {} }), /file not found/);
  // missing file + sab optional -> defaults, no throw
  const env4 = loadEnv({ PORT: { type: 'port', default: 3000 } }, { path: path.join(dir, 'nope.env'), env: {} });
  assert.strictEqual(env4.PORT, 3000);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #83: report a misplaced path and invalid schemas before reading files.
{
  const { loadEnv } = require('./index');
  const message = "loadEnv expects a schema object as the first argument — did you mean loadEnv(schema, { path: '.env' })?";
  const check = (error) => error instanceof TypeError && error.message === message;
  assert.throws(() => loadEnv('.env', { PORT: { type: 'port' } }), check);
  for (const invalid of [null, undefined, [], 42, true, Symbol('schema'), 1n, () => {}, new Date(), new Map(), new (class Schema {})()]) {
    // A throwing options getter proves invalid input is rejected before any I/O.
    assert.throws(() => loadEnv(invalid, { get path() { throw new Error('options accessed'); } }), check);
  }
  const crossRealm = require('node:vm').runInNewContext('({ PORT: { type: "port", default: 3000 } })');
  assert.strictEqual(loadEnv(crossRealm, { paths: [], env: {} }).PORT, 3000);
  const crossRealmInstance = require('node:vm').runInNewContext('(new (class Schema {})())');
  assert.throws(() => loadEnv(crossRealmInstance, { paths: [], env: {} }), check);
  assert.deepStrictEqual(loadEnv({}, { paths: [], env: {} }), {});
  const schema = Object.create(null);
  schema.PORT = { type: 'port', default: 3000 };
  assert.strictEqual(loadEnv(schema, { paths: [], env: {} }).PORT, 3000);
}

// feat: strict mode — flag variables that are set but not in the schema (fixes #4)
{
  const schema = { PORT: { type: 'port', required: true } };
  // non-strict (default): extra keys are ignored
  assert.strictEqual(validateEnv(schema, { PORT: '3000', DATABSE_URL: 'x' }).PORT, 3000);
  // strict: an unknown key becomes an error
  assert.throws(
    () => validateEnv(schema, { PORT: '3000', DATABSE_URL: 'x' }, { strict: true }),
    /DATABSE_URL: set but not in schema/
  );
  // an empty value is ignored in strict mode too (treated as missing)
  assert.strictEqual(validateEnv(schema, { PORT: '3000', EMPTY_VAR: '' }, { strict: true }).PORT, 3000);
  // ek hi pass me saari problems: unknown + missing
  assert.throws(
    () => validateEnv(schema, { DATABSE_URL: 'x' }, { strict: true }),
    (e) => e instanceof EnvSaafError
      && e.errors.length === 2
      && e.errors.some(m => m.includes('DATABSE_URL'))
      && e.errors.some(m => m.includes('PORT: missing'))
  );
}

// Issue #3: a 'url' value must come back exactly as given —
// no normalization (no added trailing slash), but an invalid URL must error
{
  const out = validateEnv({ API_URL: { type: 'url', required: true } }, { API_URL: 'https://api.example.com' });
  assert.strictEqual(out.API_URL, 'https://api.example.com');
  const out2 = validateEnv({ API_URL: { type: 'url', required: true } }, { API_URL: 'https://api.example.com/v1?x=1' });
  assert.strictEqual(out2.API_URL, 'https://api.example.com/v1?x=1');
  assert.throws(() => validateEnv({ U: { type: 'url' } }, { U: 'not a url' }), /valid URL/);
}

// Issue #5: CLI 'check --file <name>' — compare against the given file instead of .env.example
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-cli-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'const x = process.env.MY_FLAG;');
  fs.writeFileSync(path.join(dir, '.env.sample'), 'MY_FLAG=1\n');
  const cli = path.join(__dirname, 'cli.js');
  // --file .env.sample: everything is documented, exit 0 (must not throw)
  execFileSync('node', [cli, 'check', dir, '--file', '.env.sample'], { stdio: 'pipe' });
  // without --file: no .env.example present, exit 2
  let code = 0;
  try { execFileSync('node', [cli, 'check', dir], { stdio: 'pipe' }); } catch (e) { code = e.status; }
  assert.strictEqual(code, 2);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #15: scanCode — let aur var destructuring of process.env (previously only const)
{
  assert.deepStrictEqual(
    scanCode('let { A } = process.env; var { B } = process.env; const { C } = process.env;'),
    ['A', 'B', 'C']
  );
  assert.deepStrictEqual(
    scanCode('let { API_URL: api = "http://localhost" } = process.env; var { PORT = 3000 } = process.env;'),
    ['API_URL', 'PORT']
  );
}

// Issue #18: boolean type — also accept 'on'/'off' (and 'y'/'n')
{
  const b = (v) => validateEnv({ F: { type: 'boolean' } }, { F: v }).F;
  assert.strictEqual(b('on'), true);
  assert.strictEqual(b('ON'), true);
  assert.strictEqual(b('On'), true);
  assert.strictEqual(b('off'), false);
  assert.strictEqual(b('OFF'), false);
  assert.strictEqual(b('Off'), false);
  assert.strictEqual(b('y'), true);
  assert.strictEqual(b('n'), false);
  assert.strictEqual(b('yes'), true);
  assert.strictEqual(b('no'), false);
  assert.strictEqual(b('1'), true);
  assert.strictEqual(b('0'), false);
  assert.throws(() => validateEnv({ F: { type: 'boolean' } }, { F: 'enabled' }), /expected a boolean/);
  // end-to-end: a .env file with FEATURE_X=on / DEBUG=off
  const { parseEnvFile } = require('./index');
  const parsed = validateEnv(
    { FEATURE_X: { type: 'boolean' }, DEBUG: { type: 'boolean' } },
    parseEnvFile('FEATURE_X=on\nDEBUG=off\n')
  );
  assert.strictEqual(parsed.FEATURE_X, true);
  assert.strictEqual(parsed.DEBUG, false);
}

// Issue #19: CLI '--help' / '-h' — print usage, exit 0 (asking for help is not an error)
{
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  // --help aur -h: exit 0, usage text stdout par
  const outHelp = execFileSync('node', [cli, '--help'], { encoding: 'utf8' });
  assert.ok(outHelp.includes('Usage: env-saaf'));
  const outH = execFileSync('node', [cli, '-h'], { encoding: 'utf8' });
  assert.ok(outH.includes('Usage: env-saaf'));
  // an unknown command still exits 2
  let code = 0;
  try { execFileSync('node', [cli, 'frobnicate'], { stdio: 'pipe' }); } catch (e) { code = e.status; }
  assert.strictEqual(code, 2);
  // no-args ab bhi usage + exit 0
  const outNone = execFileSync('node', [cli], { encoding: 'utf8' });
  assert.ok(outNone.includes('Usage: env-saaf'));
}

// Issue #62: --no-color is accepted globally and the CLI keeps its output plain.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-plain-'));

  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'const value = process.env.PLAIN_OUTPUT;');
    const commands = [
      { args: ['--no-color', 'scan', dir] },
      { args: ['scan', '--no-color', dir] },
      { args: ['scan', dir, '--no-color'] },
      { args: ['scan', dir], env: { ...process.env, NO_COLOR: '1' } },
    ];
    for (const { args, env } of commands) {
      const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
      assert.strictEqual(run.status, 0, args.join(' '));
      assert.strictEqual(run.stdout.trim(), 'PLAIN_OUTPUT');
      assert.strictEqual(run.stderr, '');
    }

    const json = spawnSync(process.execPath, [cli, 'scan', '--no-color', dir, '--json'], { encoding: 'utf8' });
    assert.strictEqual(json.status, 0);
    assert.deepStrictEqual(JSON.parse(json.stdout), { ok: true, vars: ['PLAIN_OUTPUT'] });

    const help = spawnSync(process.execPath, [cli, '--no-color', '--help'], { encoding: 'utf8' });
    assert.strictEqual(help.status, 0);
    assert.ok(help.stdout.includes('--no-color'));
    assert.strictEqual(help.stderr, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #24: CLI --json output for check and scan
{
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-json-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'const x = process.env.MISSING_KEY;\nconst y = process.env.OK_KEY;');
  fs.writeFileSync(path.join(dir, '.env.example'), 'OK_KEY=1\nEXTRA_KEY=2\n');

  // check --json: missing used-not-documented, extra documented-not-used, ok false, exit 1
  let code = 0;
  let out = '';
  try {
    out = execFileSync('node', [cli, 'check', dir, '--json'], { encoding: 'utf8' });
  } catch (e) {
    code = e.status;
    out = e.stdout;
  }
  assert.strictEqual(code, 1);
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.ok, false);
  assert.deepStrictEqual(parsed.missing, ['MISSING_KEY']);
  assert.deepStrictEqual(parsed.extra, ['EXTRA_KEY']);
  assert.deepStrictEqual(parsed.invalid, []);

  // scan --json: lists vars, ok true, exit 0
  const scanOut = execFileSync('node', [cli, 'scan', dir, '--json'], { encoding: 'utf8' });
  const scanParsed = JSON.parse(scanOut);
  assert.strictEqual(scanParsed.ok, true);
  assert.deepStrictEqual(scanParsed.vars.sort(), ['MISSING_KEY', 'OK_KEY']);

  // human output still default (no --json)
  const humanOut = execFileSync('node', [cli, 'scan', dir], { encoding: 'utf8' });
  assert.ok(humanOut.includes('MISSING_KEY'));
  assert.ok(!humanOut.includes('{'));

  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #70: CLI scan finds literal env reads in TypeScript modules.
{
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-ts-cli-'));

  try {
    fs.writeFileSync(path.join(dir, 'service.ts'), [
      "enum Mode { Hosted = 'hosted' }",
      "export const hosts = { [Mode.Hosted]: process.env['SERVICE_HOST'] } as const;",
    ].join('\n'));
    fs.mkdirSync(path.join(dir, 'nested'));
    fs.writeFileSync(path.join(dir, 'nested', 'server.mts'), [
      'export namespace Server {',
      '  const { API_PORT: port } = process.env;',
      '  export const config = { port, endpoint: process.env.SERVICE_HOST } as const;',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'worker.cts'), [
      "const { QUEUE_NAME = 'default' } = process.env;",
      'export const config = { queue: QUEUE_NAME, tracing: process.env["TRACE_MODE"] } as const;',
    ].join('\n'));
    const output = execFileSync(process.execPath, [path.join(__dirname, 'cli.js'), 'scan', dir, '--json'], {
      encoding: 'utf8',
    });
    assert.deepStrictEqual(JSON.parse(output), {
      ok: true,
      vars: ['API_PORT', 'QUEUE_NAME', 'SERVICE_HOST', 'TRACE_MODE'],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #30: parseEnvFile — multiline quoted values keep their newlines
// (PEM keys, JSON blobs); the key after the closing quote still parses.
assert.deepStrictEqual(
  parseEnvFile('KEY="-----BEGIN-----\nabc123\n-----END-----"\nNEXT=ok\n'),
  { KEY: '-----BEGIN-----\nabc123\n-----END-----', NEXT: 'ok' });
assert.deepStrictEqual(
  parseEnvFile("KEY='line1\nline2' # trailing\nNEXT=ok\n"),
  { KEY: 'line1\nline2', NEXT: 'ok' });

// Issue #22: parseEnvFile — ${VAR} interpolation in double-quoted and
// unquoted values; the file's own values win over process.env; nested
// references expand; single-quoted and \${...} escapes stay literal;
// unknown names expand to an empty string.
assert.deepStrictEqual(
  parseEnvFile('HOST=example.com\nURL=https://${HOST}/api\n'),
  { HOST: 'example.com', URL: 'https://example.com/api' });
assert.deepStrictEqual(
  parseEnvFile('A=hello\nB=${A} world\nC=${B}!\n'),
  { A: 'hello', B: 'hello world', C: 'hello world!' });
assert.deepStrictEqual(
  parseEnvFile("A=hello\nB='${A}'\n"),
  { A: 'hello', B: '${A}' });
assert.deepStrictEqual(
  parseEnvFile('A=hello\nB=\\${A}\n'),
  { A: 'hello', B: '${A}' });
assert.deepStrictEqual(
  parseEnvFile('B=x${MISSING_VAR}y\n'),
  { B: 'xy' });

// Issue #25: loadEnv — multiple files; later files override earlier ones,
// via `paths: [...]` or `path` as an array.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadEnv } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-multi-'));
  const f1 = path.join(dir, '.env');
  const f2 = path.join(dir, '.env.local');
  fs.writeFileSync(f1, 'PORT=3000\nHOST=base\n');
  fs.writeFileSync(f2, 'HOST=local\n');
  const merged = loadEnv(
    { PORT: { type: 'port', required: true }, HOST: { type: 'string', required: true } },
    { paths: [f1, f2], env: {} });
  assert.strictEqual(merged.PORT, 3000);
  assert.strictEqual(merged.HOST, 'local');
  const viaArray = loadEnv({ HOST: { type: 'string' } }, { path: [f1, f2], env: {} });
  assert.strictEqual(viaArray.HOST, 'local');
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #34: per-key 'transform' — custom parsing after coercion
{
  const { validateEnv, loadEnv } = require('./index');
  // the issue's own examples: split a comma list, normalise case
  const t1 = validateEnv({
    ALLOWED_ORIGINS: { type: 'string', transform: v => v.split(',').map(s => s.trim()) },
    SHOUTY_NAME: { type: 'string', transform: v => v.toUpperCase() },
  }, { ALLOWED_ORIGINS: 'a.com, b.com ,c.com', SHOUTY_NAME: 'hello' });
  assert.deepStrictEqual(t1.ALLOWED_ORIGINS, ['a.com', 'b.com', 'c.com']);
  assert.strictEqual(t1.SHOUTY_NAME, 'HELLO');
  // transform runs AFTER coercion and the choices check: a port arrives as a number
  const t2 = validateEnv({ PORT_PLUS: { type: 'port', transform: n => n + 1 } }, { PORT_PLUS: '3000' });
  assert.strictEqual(t2.PORT_PLUS, 3001);
  // a choices failure skips the transform entirely
  let transformCalled = false;
  assert.throws(
    () => validateEnv(
      { MODE: { type: 'string', choices: ['a', 'b'], transform: v => { transformCalled = true; return v; } } },
      { MODE: 'c' }
    ),
    /expected one of/
  );
  assert.strictEqual(transformCalled, false);
  // a throwing transform is collected as a normal validation error, naming the key —
  // and it does not hide the other keys' errors
  assert.throws(
    () => validateEnv({
      BAD: { type: 'string', transform: () => { throw new Error('nope'); } },
      MISSING: { type: 'string', required: true },
    }, { BAD: 'x' }),
    (e) => e instanceof EnvSaafError
      && e.errors.length === 2
      && e.errors.some(m => m.includes('BAD: transform failed: nope'))
      && e.errors.some(m => m.includes('MISSING: missing'))
  );
  // transform does NOT run on defaults — a default passes through untouched
  let defaultTransformed = false;
  const t3 = validateEnv(
    { GREETING: { type: 'string', default: 'hi', transform: v => { defaultTransformed = true; return v + '!'; } } },
    {}
  );
  assert.strictEqual(t3.GREETING, 'hi');
  assert.strictEqual(defaultTransformed, false);
  // a non-function transform is a schema error naming the key
  assert.throws(
    () => validateEnv({ A: { type: 'string', transform: 'split' } }, { A: 'x' }),
    /A: "transform" must be a function/
  );
  // end-to-end: loadEnv applies transforms too (it validates through validateEnv)
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-transform-'));
  fs.writeFileSync(path.join(dir, '.env'), 'ALLOWED_ORIGINS=a.com, b.com\n');
  const loaded = loadEnv(
    { ALLOWED_ORIGINS: { type: 'string', required: true, transform: v => v.split(',').map(s => s.trim()) } },
    { path: path.join(dir, '.env'), env: {} }
  );
  assert.deepStrictEqual(loaded.ALLOWED_ORIGINS, ['a.com', 'b.com']);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #23: 'email' type and 'pattern' option for strings
{
  const { validateEnv } = require('./index');
  // email: pragmatic validation — one '@', non-empty local/domain, a dot in the domain
  assert.strictEqual(validateEnv({ E: { type: 'email' } }, { E: 'a@b.co' }).E, 'a@b.co');
  assert.strictEqual(validateEnv({ E: { type: 'email' } }, { E: 'first.last+tag@sub.example.org' }).E, 'first.last+tag@sub.example.org');
  for (const bad of ['not-an-email', 'a@b', '@b.co', 'a@.co', 'a@b.', 'a@@b.co', 'a b@c.co', 'a@c']) {
    assert.throws(() => validateEnv({ E: { type: 'email' } }, { E: bad }), /expected a valid email address/);
  }
  // pattern: a slug and a prefixed key; the mismatch error names the pattern
  const p = validateEnv({
    SLUG: { type: 'string', pattern: /^[a-z0-9-]+$/ },
    API_KEY: { type: 'string', pattern: /^sk_[A-Za-z0-9]+$/ },
  }, { SLUG: 'my-post-2', API_KEY: 'sk_abc123' });
  assert.strictEqual(p.SLUG, 'my-post-2');
  assert.strictEqual(p.API_KEY, 'sk_abc123');
  assert.throws(
    () => validateEnv({ S: { type: 'string', pattern: /^[a-z0-9-]+$/ } }, { S: 'Bad Slug!' }),
    (e) => e instanceof EnvSaafError && e.errors.some(m => m.includes('S: expected to match /^[a-z0-9-]+$/'))
  );
  // pattern also works with the email type, and runs after the choices check
  assert.strictEqual(
    validateEnv({ E: { type: 'email', pattern: /@example\.com$/ } }, { E: 'a@example.com' }).E, 'a@example.com');
  assert.throws(
    () => validateEnv({ E: { type: 'email', pattern: /@example\.com$/ } }, { E: 'a@other.com' }),
    /expected to match/
  );
  // a non-RegExp pattern is a schema error naming the key
  assert.throws(
    () => validateEnv({ S: { type: 'string', pattern: '[a-z]+' } }, { S: 'abc' }),
    /S: "pattern" must be a RegExp/
  );
}

// Issue #33: scanCode finds process.env[`KEY`] template-literal access,
// but not interpolated names — those cannot be known statically.
assert.deepStrictEqual(
  scanCode('const v = process.env[`DYNAMIC_NAME`]; const w = process.env[`PREFIX_${SUFFIX}`];'),
  ['DYNAMIC_NAME']);
assert.deepStrictEqual(
  scanCode('process.env.API_URL; process.env[\'BRACKET\']; process.env[`TICK`];'),
  ['API_URL', 'BRACKET', 'TICK']);


// Issues #45 + #47: 'int' type (whole numbers only) and min/max for numbers.
{
  const ints = validateEnv({ N: { type: 'int', required: true } }, { N: '42' });
  assert.strictEqual(ints.N, 42);
  assert.strictEqual(validateEnv({ N: { type: 'int' } }, { N: '-3' }).N, -3);
  assert.strictEqual(validateEnv({ N: { type: 'int' } }, { N: '1e3' }).N, 1000); // 1e3 is a whole value
  assert.strictEqual(validateEnv({ N: { type: 'int' } }, { N: '1.5e2' }).N, 150); // 1.5e2 is whole too
  assert.throws(() => validateEnv({ N: { type: 'int' } }, { N: '3.5' }), /expected an integer/);
  assert.throws(() => validateEnv({ N: { type: 'int' } }, { N: 'abc' }), /expected an integer/);
  // min/max: both, min alone, max alone; the error names the allowed range.
  assert.strictEqual(validateEnv({ N: { type: 'number', min: 1, max: 10 } }, { N: '5' }).N, 5);
  assert.throws(() => validateEnv({ N: { type: 'number', min: 1 } }, { N: '0' }), /at least 1/);
  assert.throws(() => validateEnv({ N: { type: 'number', max: 10 } }, { N: '11' }), /at most 10/);
  assert.throws(() => validateEnv({ N: { type: 'number', min: 1, max: 10 } }, { N: '99' }), /1\u201310/);
  // min/max also apply to int and port.
  assert.strictEqual(validateEnv({ N: { type: 'int', min: 0 } }, { N: '7' }).N, 7);
  assert.throws(() => validateEnv({ N: { type: 'int', min: 0 } }, { N: '-1' }), /at least 0/);
  assert.throws(() => validateEnv({ P: { type: 'port', max: 1024 } }, { P: '8080' }), /at most 1024/);
  // min/max leave non-numeric values alone.
  assert.strictEqual(validateEnv({ S: { type: 'string', min: 1 } }, { S: 'x' }).S, 'x');
}

// Issues #32 + #48: 'json' type (parse JSON values) and minLength/maxLength for strings.
{
  // json: objects, arrays and primitives are parsed and returned as-is.
  assert.deepStrictEqual(
    validateEnv({ F: { type: 'json', required: true } }, { F: '{"beta":true,"maxItems":3}' }).F,
    { beta: true, maxItems: 3 });
  assert.deepStrictEqual(
    validateEnv({ F: { type: 'json' } }, { F: '[1, "two", null]' }).F, [1, 'two', null]);
  assert.strictEqual(validateEnv({ F: { type: 'json' } }, { F: '42' }).F, 42);
  assert.strictEqual(validateEnv({ F: { type: 'json' } }, { F: '"hello"' }).F, 'hello');
  assert.strictEqual(validateEnv({ F: { type: 'json' } }, { F: 'true' }).F, true);
  assert.strictEqual(validateEnv({ F: { type: 'json' } }, { F: 'null' }).F, null);
  // Invalid JSON is a normal collected error naming the key.
  assert.throws(() => validateEnv({ F: { type: 'json' } }, { F: '{not json' }), /expected valid JSON/);
  assert.throws(() => validateEnv({ F: { type: 'json', required: true } }, { F: '' }), /missing required variable/);
  // A default may be given as an already-parsed object.
  assert.deepStrictEqual(
    validateEnv({ F: { type: 'json', default: { beta: false } } }, {}).F, { beta: false });
  // An already-parsed value passed directly in the env object passes through.
  assert.deepStrictEqual(
    validateEnv({ F: { type: 'json' } }, { F: { beta: true } }).F, { beta: true });
  // json works with required/default like every other type.
  assert.throws(() => validateEnv({ F: { type: 'json', required: true } }, {}), EnvSaafError);

  // minLength/maxLength: both, min alone, max alone; the error names the allowed length.
  assert.strictEqual(validateEnv({ S: { type: 'string', minLength: 2, maxLength: 5 } }, { S: 'abc' }).S, 'abc');
  assert.throws(() => validateEnv({ S: { type: 'string', minLength: 3 } }, { S: 'ab' }), /at least 3 characters/);
  assert.throws(() => validateEnv({ S: { type: 'string', maxLength: 2 } }, { S: 'abc' }), /at most 2 characters/);
  assert.throws(() => validateEnv({ S: { type: 'string', minLength: 2, maxLength: 4 } }, { S: 'abcdef' }), /2\u20134 characters/);
  // Length is checked after coercion, so surrounding whitespace is trimmed first.
  assert.strictEqual(validateEnv({ S: { type: 'string', minLength: 3, maxLength: 3 } }, { S: '  abc  ' }).S, 'abc');
  // Combines with pattern: length is checked first, then the pattern.
  assert.throws(() => validateEnv({ S: { type: 'string', minLength: 5, pattern: /^[a-z]+$/ } }, { S: 'ab1' }), /at least 5 characters/);
  assert.throws(() => validateEnv({ S: { type: 'string', minLength: 2, pattern: /^[a-z]+$/ } }, { S: 'ab1' }), /expected to match/);
  // Applies to email and url values too; non-string values skip the check.
  assert.throws(() => validateEnv({ E: { type: 'email', maxLength: 5 } }, { E: 'a@b.co' }), /at most 5 characters/);
  assert.strictEqual(validateEnv({ N: { type: 'number', minLength: 5 } }, { N: '42' }).N, 42);
  // Bad option values are a clear rule error, not a crash.
  assert.throws(() => validateEnv({ S: { type: 'string', minLength: -1 } }, { S: 'abc' }), /non-negative integers/);
  assert.throws(() => validateEnv({ S: { type: 'string', maxLength: 2.5 } }, { S: 'abc' }), /non-negative integers/);
}

console.log('env-saaf v1.2.0: all tests passed');

