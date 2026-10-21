import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import { stopAndCaptureRouterLogs, ROUTER_LOG_MAX_BYTES } from './router-log-capture';
import { resolveArtifactOwner } from '../resolved-config-artifact';
import { logger } from '../logger';

jest.mock('execa', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../logger', () => ({ logger: { debug: jest.fn(), warn: jest.fn() } }));

const actualExeca = jest.requireActual('execa') as typeof execa;
const mockedExeca = execa as jest.MockedFunction<typeof execa>;
const id = 'a'.repeat(64);
const captureRouterLogs = (
  workDir: string,
  routerLogs: string,
  unsafeDirs: { audit?: string; sessionState?: string },
): Promise<void> => stopAndCaptureRouterLogs(workDir, {
  routerLogs, auditDir: unsafeDirs.audit, sessionState: unsafeDirs.sessionState,
});

describe('stopAndCaptureRouterLogs', () => {
  let root: string;
  let workDir: string;
  let destination: string;
  let scripts: string[];
  let previousProject: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    previousProject = process.env.COMPOSE_PROJECT_NAME;
    delete process.env.COMPOSE_PROJECT_NAME;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-log-capture-tests-'));
    workDir = path.join(root, 'awf-project');
    fs.mkdirSync(workDir);
    fs.writeFileSync(path.join(workDir, 'docker-compose.yml'), 'services: {}\n');
    destination = path.join(root, 'router-logs');
    scripts = [
      `process.stdout.write('${id}\\n')`,
      `process.stdout.write(${JSON.stringify(JSON.stringify({
        'com.docker.compose.project': 'awf-project',
        'com.docker.compose.service': 'router',
      }))})`,
      '',
      'process.stdout.write(\'{"stream":"stdout"}\\n\'); process.stderr.write(\'{"stream":"stderr"}\\n\')',
    ];
    mockedExeca.mockImplementation(((_file: string, _args: string[], options: execa.Options) => {
      const script = scripts.shift();
      if (script === undefined) throw new Error('Unexpected docker command');
      return actualExeca(process.execPath, ['-e', script], options);
    }) as typeof execa);
  });

  afterEach(() => {
    if (previousProject === undefined) delete process.env.COMPOSE_PROJECT_NAME;
    else process.env.COMPOSE_PROJECT_NAME = previousProject;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('discovers the compose-owned stopped container, stops by id, and streams both complete logs', async () => {
    scripts[3] += '; process.stdout.write("x".repeat(100000))';
    await captureRouterLogs(workDir, destination, {});
    const output = fs.readFileSync(path.join(destination, 'router.jsonl'), 'utf8');
    expect(output).toContain('{"stream":"stdout"}\n');
    expect(output).toContain('{"stream":"stderr"}\n');
    expect(output).toContain('x'.repeat(100000));
    expect(mockedExeca.mock.calls.map(call => call[1])).toEqual([
      ['compose', 'ps', '--all', '--quiet', 'router'],
      ['inspect', '--format', '{{json .Config.Labels}}', id],
      ['stop', id, '-t', '1'],
      ['logs', id],
    ]);
    for (const call of mockedExeca.mock.calls as unknown as Array<[string, string[], execa.Options]>) {
      expect(call[2]).toMatchObject({ cwd: workDir });
    }
    expect(logger.warn).not.toHaveBeenCalled();
    const dir = fs.statSync(destination);
    const file = fs.statSync(path.join(destination, 'router.jsonl'));
    expect(dir.mode & 0o777).toBe(0o700);
    expect(file.mode & 0o777).toBe(0o600);
    expect(file.uid).toBe(resolveArtifactOwner().uid);
    expect(file.gid).toBe(resolveArtifactOwner().gid);
    expect(dir.uid).toBe(file.uid);
    expect(dir.gid).toBe(file.gid);
  });

  it('only debug-logs when no router exists', async () => {
    scripts = [''];
    await captureRouterLogs(workDir, destination, {});
    expect(logger.debug).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(fs.existsSync(destination)).toBe(false);
  });

  it.each(['process.exit(1)', 'process.stdout.write("awf-router")'])('treats failed or invalid discovery as nonfatal', async script => {
    scripts = [script];
    await expect(captureRouterLogs(workDir, destination, {})).resolves.toBeUndefined();
    expect(mockedExeca).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does not stop a container when ownership inspection fails', async () => {
    scripts[1] = 'process.exit(1)';
    await captureRouterLogs(workDir, destination, {});
    expect(mockedExeca).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalled();
  });

  it.each([
    { 'com.docker.compose.project': 'another-project', 'com.docker.compose.service': 'router' },
    { 'com.docker.compose.project': 'awf-project', 'com.docker.compose.service': 'agent' },
  ])('rejects foreign compose labels %j without stopping anything', async labels => {
    scripts[1] = `process.stdout.write(${JSON.stringify(JSON.stringify(labels))})`;
    await captureRouterLogs(workDir, destination, {});
    expect(mockedExeca).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalled();
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('honors the compose project override', async () => {
    process.env.COMPOSE_PROJECT_NAME = 'custom-project';
    scripts[1] = scripts[1].replace('awf-project', 'custom-project');
    await captureRouterLogs(workDir, destination, {});
    expect(fs.existsSync(path.join(destination, 'router.jsonl'))).toBe(true);
  });

  it('honors a project name declared in the compose file', async () => {
    fs.writeFileSync(path.join(workDir, 'docker-compose.yml'), 'name: named-project\nservices: {}\n');
    scripts[1] = scripts[1].replace('awf-project', 'named-project');
    await captureRouterLogs(workDir, destination, {});
    expect(fs.existsSync(path.join(destination, 'router.jsonl'))).toBe(true);
  });

  it('captures even if stopping fails, with an independent warning', async () => {
    scripts[2] = 'process.exit(1)';
    scripts[3] = 'process.stdout.write("partial"); process.exit(2)';
    await captureRouterLogs(workDir, destination, {});
    expect(fs.readFileSync(path.join(destination, 'router.jsonl'), 'utf8')).toBe('partial');
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not stop router'), expect.anything());
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('incomplete'));
  });

  it('caps combined streams before writing disk and preserves the partial file', async () => {
    scripts[3] = `process.stdout.write(Buffer.alloc(${ROUTER_LOG_MAX_BYTES}, 120)); process.stderr.write(Buffer.alloc(65536, 121));`;
    await captureRouterLogs(workDir, destination, {});
    expect(fs.statSync(path.join(destination, 'router.jsonl')).size).toBe(ROUTER_LOG_MAX_BYTES);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('16 MiB limit'));
  });

  it('bounds discovery to its deadline without creating a log file', async () => {
    scripts[0] = 'setInterval(() => {}, 1000)';
    const started = Date.now();
    await captureRouterLogs(workDir, destination, {});
    expect(Date.now() - started).toBeLessThan(5000);
    expect(logger.warn).toHaveBeenCalled();
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('still captures after a bounded stop timeout', async () => {
    scripts[2] = 'setInterval(() => {}, 1000)';
    await captureRouterLogs(workDir, destination, {});
    expect(fs.readFileSync(path.join(destination, 'router.jsonl'), 'utf8')).toContain('stdout');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('preserves partial logs on the shared five-second deadline', async () => {
    scripts[3] = 'process.stdout.write("partial"); setInterval(() => {}, 1000)';
    const started = Date.now();
    await captureRouterLogs(workDir, destination, {});
    expect(Date.now() - started).toBeLessThan(5500);
    expect(fs.readFileSync(path.join(destination, 'router.jsonl'), 'utf8')).toBe('partial');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('incomplete'));
  }, 10_000);

  it.each(['ancestor', 'destination', 'file'])('refuses a symlink at %s without changing its target', async kind => {
    const target = path.join(root, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'router.jsonl'), 'untouched');
    if (kind === 'ancestor') {
      fs.symlinkSync(target, path.join(root, 'link'));
      destination = path.join(root, 'link', 'nested');
    } else if (kind === 'destination') {
      fs.symlinkSync(target, destination);
    } else {
      fs.mkdirSync(destination);
      fs.symlinkSync(path.join(target, 'router.jsonl'), path.join(destination, 'router.jsonl'));
    }
    await captureRouterLogs(workDir, destination, {});
    expect(fs.readFileSync(path.join(target, 'router.jsonl'), 'utf8')).toBe('untouched');
    expect(logger.warn).toHaveBeenCalled();
    expect(mockedExeca).toHaveBeenCalledTimes(3);
  });

  it.each(['hardlink', 'directory', 'fifo'])('refuses an existing %s log file', async kind => {
    fs.mkdirSync(destination);
    const file = path.join(destination, 'router.jsonl');
    const target = path.join(root, 'target');
    fs.writeFileSync(target, 'untouched');
    if (kind === 'hardlink') fs.linkSync(target, file);
    else if (kind === 'directory') fs.mkdirSync(file);
    else await actualExeca('mkfifo', [file]);
    await captureRouterLogs(workDir, destination, {});
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
    expect(logger.warn).toHaveBeenCalled();
    expect(mockedExeca).toHaveBeenCalledTimes(3);
  });

  it.each(['audit', 'sessionState'] as const)('rejects either-direction %s overlap including symlink aliases', async key => {
    for (const unsafe of [destination, path.join(destination, 'nested'), root]) {
      await captureRouterLogs(workDir, destination, { [key]: unsafe });
      expect(fs.existsSync(destination)).toBe(false);
      scripts = [
        `process.stdout.write('${id}')`,
        `process.stdout.write(${JSON.stringify(JSON.stringify({
          'com.docker.compose.project': 'awf-project', 'com.docker.compose.service': 'router',
        }))})`, '', '',
      ];
    }
    fs.mkdirSync(destination);
    const alias = path.join(root, 'alias');
    fs.symlinkSync(destination, alias);
    await captureRouterLogs(workDir, destination, { [key]: path.join(alias, 'nested') });
    expect(fs.existsSync(path.join(destination, 'router.jsonl'))).toBe(false);
  });

  it.each(['audit', 'agent-session-state', 'diagnostics'])('guards the default %s directory when options omit it', async protectedName => {
    destination = path.join(workDir, protectedName, 'router-logs');
    await stopAndCaptureRouterLogs(workDir, { routerLogs: destination });
    expect(fs.existsSync(destination)).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it.each(['audit', 'agent-session-state'])('still guards default %s when custom directories are configured', async protectedName => {
    destination = path.join(workDir, protectedName, 'router-logs');
    await stopAndCaptureRouterLogs(workDir, {
      routerLogs: destination,
      auditDir: path.join(root, 'custom-audit'),
      sessionState: path.join(root, 'custom-session'),
    });
    expect(fs.existsSync(destination)).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('refuses a diagnostics symlink alias before exposing router logs to recursive publication', async () => {
    fs.mkdirSync(destination);
    fs.symlinkSync(destination, path.join(workDir, 'diagnostics'));
    await stopAndCaptureRouterLogs(workDir, { routerLogs: destination });
    expect(fs.existsSync(path.join(destination, 'router.jsonl'))).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      message: expect.stringContaining('diagnostics'),
    }));
  });

  it('uses the strict sudo identity without a safe-UID fallback', async () => {
    if (process.getuid?.() !== 0) return;
    const previousUid = process.env.SUDO_UID;
    const previousGid = process.env.SUDO_GID;
    process.env.SUDO_UID = '500';
    process.env.SUDO_GID = '501';
    try {
      await stopAndCaptureRouterLogs(workDir, { routerLogs: destination });
      const stat = fs.statSync(path.join(destination, 'router.jsonl'));
      expect(stat.uid).toBe(500);
      expect(stat.gid).toBe(501);
    } finally {
      if (previousUid === undefined) delete process.env.SUDO_UID;
      else process.env.SUDO_UID = previousUid;
      if (previousGid === undefined) delete process.env.SUDO_GID;
      else process.env.SUDO_GID = previousGid;
    }
  });

  it('refuses malformed sudo ownership rather than substituting a fallback', async () => {
    if (process.getuid?.() !== 0) return;
    const previousUid = process.env.SUDO_UID;
    const previousGid = process.env.SUDO_GID;
    process.env.SUDO_UID = '1000invalid';
    process.env.SUDO_GID = '1000';
    try {
      await stopAndCaptureRouterLogs(workDir, { routerLogs: destination });
      expect(fs.existsSync(destination)).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    } finally {
      if (previousUid === undefined) delete process.env.SUDO_UID;
      else process.env.SUDO_UID = previousUid;
      if (previousGid === undefined) delete process.env.SUDO_GID;
      else process.env.SUDO_GID = previousGid;
    }
  });

  it('tightens permissive existing modes', async () => {
    fs.mkdirSync(destination, { mode: 0o755 });
    const file = path.join(destination, 'router.jsonl');
    fs.writeFileSync(file, 'old', { mode: 0o640 });
    await captureRouterLogs(workDir, destination, {});
    expect(fs.statSync(destination).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('repairs restrictive modes to exact private directory and file modes', async () => {
    fs.mkdirSync(destination, { mode: 0o700 });
    const file = path.join(destination, 'router.jsonl');
    fs.writeFileSync(file, 'old', { mode: process.getuid?.() === 0 ? 0o400 : 0o200 });
    fs.chmodSync(destination, 0o500);
    await captureRouterLogs(workDir, destination, {});
    expect(fs.statSync(destination).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('rejects a log directory owned by a foreign user', async () => {
    if (process.getuid?.() !== 0) return;
    fs.mkdirSync(destination, { mode: 0o700 });
    fs.chownSync(destination, resolveArtifactOwner().uid + 1, resolveArtifactOwner().gid);
    await captureRouterLogs(workDir, destination, {});
    expect(fs.existsSync(path.join(destination, 'router.jsonl'))).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('rejects a regular log file owned by a foreign user before truncating it', async () => {
    if (process.getuid?.() !== 0) return;
    fs.mkdirSync(destination, { mode: 0o700 });
    const file = path.join(destination, 'router.jsonl');
    fs.writeFileSync(file, 'untouched');
    fs.chownSync(file, resolveArtifactOwner().uid + 1, resolveArtifactOwner().gid);
    await captureRouterLogs(workDir, destination, {});
    expect(fs.readFileSync(file, 'utf8')).toBe('untouched');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('creates missing nested directories privately', async () => {
    destination = path.join(destination, 'one', 'two');
    await captureRouterLogs(workDir, destination, {});
    for (const directory of [destination, path.dirname(destination), path.dirname(path.dirname(destination))]) {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    }
  });
});
