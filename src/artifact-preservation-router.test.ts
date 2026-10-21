// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { preserveCleanupArtifacts } from './artifact-preservation';
import { mockExecaSync } from './test-helpers/mock-execa.test-utils';

describe('private router log preservation', () => {
  let workDir: string;
  const directories: string[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecaSync.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-'));
    directories.push(workDir);
  });

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function writeLogs(parent: string): string {
    const directory = path.join(parent, 'router-logs');
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'router.jsonl'), '{"event":"stopped"}\n', { mode: 0o600 });
    return directory;
  }

  function expectPrivate(directory: string): void {
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(directory, 'router.jsonl')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(directory, 'router.jsonl')).uid).toBe(process.getuid!());
    for (const [command, args] of mockExecaSync.mock.calls) {
      if (command !== 'chmod') continue;
      expect(args).not.toContain(directory);
      expect(args).not.toContain(path.join(directory, 'router.jsonl'));
      if (args.includes('-R')) expect(args).not.toContain(path.dirname(directory));
    }
  }

  it('moves default router logs outside workDir without changing permissions', () => {
    writeLogs(workDir);
    const destination = path.join(os.tmpdir(), `router-logs-${path.basename(workDir).replace('awf-', '')}`);
    directories.push(destination);

    preserveCleanupArtifacts(workDir);

    expect(fs.existsSync(path.join(workDir, 'router-logs'))).toBe(false);
    expectPrivate(destination);
  });

  it.each([undefined, '/host', '/tmp'])(
    'leaves host-written logs under proxyLogsDir with Docker prefix %s',
    (dockerHostPathPrefix) => {
      const proxyLogsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-artifacts-'));
      directories.push(proxyLogsDir);
      const directory = writeLogs(proxyLogsDir);

      preserveCleanupArtifacts(workDir, { proxyLogsDir, dockerHostPathPrefix });

      expectPrivate(directory);
    },
  );

  it('does not create logs when routing is off', () => {
    preserveCleanupArtifacts(workDir);

    expect(fs.existsSync(path.join(workDir, 'router-logs'))).toBe(false);
    expect(mockExecaSync).not.toHaveBeenCalled();
  });
});
