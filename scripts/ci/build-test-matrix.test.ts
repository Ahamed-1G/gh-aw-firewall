import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

const root = path.resolve(__dirname, '../..');
const script = path.join(__dirname, 'build-test-matrix.sh');

describe('build test matrix', () => {
  let directory: string;
  let bin: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'build-matrix-'));
    bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    const fixture = path.join(bin, 'fixture');
    fs.writeFileSync(fixture, `#!/bin/bash
set -eu
tool="\${0##*/}"
printf '%s|%s|%s\\n' "$tool" "$PWD" "$*" >> "$CALLS"
if [[ "$tool" == git ]]; then
  if [[ "\${FAIL_CLONE:-}" == all || "$*" == *"test-\${FAIL_CLONE:-none}.git"* ]]; then
    echo "clone failed" >&2
    exit 1
  fi
  target="\${!#}"
  for project in elysia hono fmt json oak std hello-world json-parse color env uuid gson caffeine clsx execa p-limit fd zoxide; do
    mkdir -p "$target/$project"
  done
  exit 0
fi
if [[ "$tool" == "\${FAIL_TOOL:-none}" && "$*" == *"\${FAIL_ARGUMENT:-}"* ]]; then
  printf 'failure with "quotes" and \\\\slashes\\n' >&2
  exit 1
fi
case "$tool" in
  curl) echo ':' ;;
  dotnet)
    test -w "$DOTNET_CLI_HOME"
    test -w "$XDG_RUNTIME_DIR"
    test "$DOTNET_SKIP_FIRST_TIME_EXPERIENCE" == 1 ;;
  mvn)
    test "$1" == -s
    grep -q '<host>squid-proxy</host><port>3128</port>' "$2"
    test "$3" == "-Dmaven.repo.local=$MAVEN_REPO"
    test -w "\${MAVEN_REPO%/*}"
    [[ "$*" != *test ]] || echo 'Tests run: 5, Failures: 0, Errors: 0' ;;
  go)
    if [[ "$*" == test* ]]; then
      echo '{"Action":"pass","Test":"TestOne"}'
      echo '{"Action":"pass","Test":"TestTwo"}'
      echo '{"Action":"pass","Package":"example"}'
    fi ;;
  cargo)
    if [[ "$*" == test ]]; then
      echo 'test result: ok. 3 passed; 0 failed'
      echo 'test result: ok. 2 passed; 0 failed'
    fi ;;
  bun|deno|npm)
    [[ "$*" != *test* ]] || echo '3 passed; 0 failed' ;;
esac
exit 0
`, { mode: 0o700 });
    for (const tool of ['git', 'curl', 'bun', 'deno', 'cmake', 'make', 'dotnet', 'go', 'mvn', 'npm', 'cargo']) {
      fs.symlinkSync(fixture, path.join(bin, tool));
    }
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  function run(env: Record<string, string> = {}) {
    const output = path.join(directory, 'results with spaces');
    const result = spawnSync('/bin/bash', [script, output], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: path.join(directory, 'calls'), ...env },
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.error).toBeUndefined();
    const results = JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8'));
    return { exit: result.status, results, calls: fs.readFileSync(path.join(directory, 'calls'), 'utf8') };
  }

  it('runs all 18 projects through all eight ecosystems with writable .NET/Maven settings', () => {
    const { exit, results, calls } = run();
    expect(exit).toBe(0);
    expect(results).toMatchObject({
      status: 'PASS', projectsPassed: 18, projectsTotal: 18,
      ecosystemsPassed: 8, ecosystemsTotal: 8, allClonesFailed: false,
    });
    expect(results.projects.every((project: { status: string }) => project.status === 'PASS')).toBe(true);
    expect(results.projects.find((project: { project: string }) => project.project === 'gson'))
      .toMatchObject({ stepsPassed: 2, testsPassed: 5, testsFailed: 0, errorTail: '' });
    expect(results.projects.find((project: { project: string }) => project.project === 'fmt'))
      .toMatchObject({ testsPassed: null, testsFailed: null });
    expect(results.projects.find((project: { project: string }) => project.project === 'fd'))
      .toMatchObject({ testsPassed: 5, testsFailed: 0 });
    expect(results.projects.find((project: { project: string }) => project.project === 'uuid'))
      .toMatchObject({ testsPassed: 2, testsFailed: 0 });
    expect(calls.match(/^git\|/gm)).toHaveLength(8);
    expect(calls).toContain('go|');
    expect(calls).toContain('test -json ./...');
    expect(calls).toContain('make|');
  });

  it('continues after clone failure without attempting that ecosystem builds', () => {
    const { exit, results, calls } = run({ FAIL_CLONE: 'go' });
    expect(exit).toBe(1);
    expect(results.ecosystemsPassed).toBe(7);
    expect(results.projects).toHaveLength(18);
    expect(results.projects.filter((project: { status: string }) => project.status === 'CLONE_FAILED')).toHaveLength(3);
    expect(calls).not.toMatch(/^go\|/m);
    expect(calls).toContain('cargo|');
  });

  it('records installer pipeline failures and continues other ecosystems', () => {
    const { exit, results, calls } = run({ FAIL_TOOL: 'curl', FAIL_ARGUMENT: 'bun.sh' });
    expect(exit).toBe(1);
    expect(results.projects.slice(0, 2).map((project: { status: string }) => project.status))
      .toEqual(['INSTALL_FAILED', 'INSTALL_FAILED']);
    expect(calls).not.toContain('bun|');
    expect(results.projectsPassed).toBe(16);
  });

  it('stops only the failed project, preserves quoted diagnostics, and replaces stale results', () => {
    run();
    fs.unlinkSync(path.join(directory, 'calls'));
    const { exit, results, calls } = run({ FAIL_TOOL: 'dotnet', FAIL_ARGUMENT: 'build' });
    expect(exit).toBe(1);
    expect(results.projectsPassed).toBe(16);
    const failed = results.projects.filter((project: { status: string }) => project.status === 'FAIL');
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ stepsPassed: 1 });
    expect(failed[0].errorTail).toContain('"quotes"');
    expect(failed[0].errorTail.length).toBeLessThanOrEqual(2000);
    expect(calls).not.toMatch(/^dotnet\|.*\|run$/m);
    expect(calls).toContain('cargo|');
  });

  it('records test failures without hiding later project results', () => {
    const { exit, results, calls } = run({ FAIL_TOOL: 'npm', FAIL_ARGUMENT: 'test' });
    expect(exit).toBe(1);
    expect(results.projectsPassed).toBe(15);
    expect(results.projects.filter((project: { status: string }) => project.status === 'FAIL')
      .every((project: { stepsPassed: number }) => project.stepsPassed === 1)).toBe(true);
    expect(calls).toContain('cargo|');
  });

  it('explicitly reports when all clones fail', () => {
    const { exit, results } = run({ FAIL_CLONE: 'all' });
    expect(exit).toBe(1);
    expect(results).toMatchObject({ allClonesFailed: true, projectsPassed: 0, ecosystemsPassed: 0, projectsTotal: 18 });
  });

  it('keeps execution inside AWF with a cheap model and safe-output-only GitHub writes', () => {
    const source = fs.readFileSync(path.join(root, '.github/workflows/build-test.md'), 'utf8');
    const frontmatter = yaml.load(source.split('---')[1]) as {
      engine: { model: string }; tools: Record<string, unknown>; steps?: unknown;
      sandbox: { agent: { id: string } }; 'safe-outputs': Record<string, unknown>;
    };
    expect(frontmatter.engine.model).toBe('claude-haiku-4.5');
    expect(frontmatter.tools.github).toBe(false);
    expect(frontmatter.steps).toBeUndefined();
    expect(frontmatter.sandbox.agent.id).toBe('awf');
    expect(frontmatter['safe-outputs']['add-labels']).toEqual({ allowed: ['build-test'] });
    expect(source).toContain('bash scripts/ci/build-test-matrix.sh');
    expect(source).toContain('expect 18 projects, 8 ecosystems');
    expect(source.length).toBeLessThan(3500);
    const lock = fs.readFileSync(path.join(root, '.github/workflows/build-test.lock.yml'), 'utf8');
    expect(lock).toContain('claude-haiku-4.5');
    expect(lock).not.toContain('"name":"github"');
    expect(lock).not.toContain('"github": {');
    expect(lock).not.toContain('github/github-mcp-server');
    expect(lock).toContain('Install awf binary (local)');
  });
});
