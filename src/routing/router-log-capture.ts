import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import * as yaml from 'js-yaml';
import { getLocalDockerEnv } from '../docker-host';
import { openArtifactDirectory, resolveArtifactOwner } from '../resolved-config-artifact';
import { logger } from '../logger';

export const ROUTER_LOG_MAX_BYTES = 16 * 1024 * 1024;
const CAPTURE_BUDGET_MS = 5_000;

export interface RouterLogCaptureOptions {
  routerLogs: string;
  auditDir?: string;
  sessionState?: string;
}

export function captureRouterLogs(
  workDir: string,
  routerLogs: string,
  unsafeDirectories: { audit?: string; sessionState?: string } = {},
): Promise<void> {
  return stopAndCaptureRouterLogs(workDir, {
    routerLogs, auditDir: unsafeDirectories.audit, sessionState: unsafeDirectories.sessionState,
  });
}

function canonicalPath(candidate: string): string {
  const missing: string[] = [];
  let current = path.resolve(candidate);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling symlink is not a missing directory.
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Dangling symlink in artifact path');
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function overlaps(left: string, right: string): boolean {
  const contains = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  return contains(left, right) || contains(right, left);
}

function projectName(workDir: string): string {
  if (process.env.COMPOSE_PROJECT_NAME?.trim()) return process.env.COMPOSE_PROJECT_NAME.trim();
  const compose = yaml.load(fs.readFileSync(path.join(workDir, 'docker-compose.yml'), 'utf8')) as { name?: unknown };
  if (typeof compose?.name === 'string') return compose.name;
  return path.basename(path.resolve(workDir)).toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[_-]+/, '');
}

function secureLogFile(directory: string, descriptors: number[]): number {
  const { uid, gid } = resolveArtifactOwner();
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  if (directory === path.parse(directory).root) throw new Error('Refusing filesystem root as router log directory');
  const components = [path.basename(directory)];
  let ancestor = path.dirname(directory);
  let parent: number;
  for (;;) {
    try {
      parent = ancestor === path.parse(ancestor).root ? fs.openSync(ancestor, flags) : openArtifactDirectory(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      components.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  descriptors.push(parent);
  for (const [index, component] of components.entries()) {
    const child = `/proc/self/fd/${parent}/${component}`;
    let created = false;
    try {
      fs.mkdirSync(child, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    parent = fs.openSync(child, flags);
    descriptors.push(parent);
    const stat = fs.fstatSync(parent);
    if (created || index === components.length - 1) {
      if (stat.uid !== process.getuid?.() && stat.uid !== uid) throw new Error('Router log directory has an unsafe owner');
      fs.fchmodSync(parent, stat.mode & 0o700);
      fs.fchownSync(parent, uid, gid);
    }
  }
  const fd = fs.openSync(`/proc/self/fd/${parent}/router.jsonl`,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  descriptors.push(fd);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.uid !== process.getuid?.() && stat.uid !== uid)) {
    throw new Error('Refusing unsafe router log file (owner, hardlink, or nonregular file)');
  }
  fs.fchmodSync(fd, stat.mode & 0o600);
  fs.fchownSync(fd, uid, gid);
  fs.ftruncateSync(fd, 0);
  return fd;
}

/** Best-effort capture; callers must await this before removing the compose project. */
export async function stopAndCaptureRouterLogs(
  workDir: string,
  options: RouterLogCaptureOptions,
): Promise<void> {
  const deadline = Date.now() + CAPTURE_BUDGET_MS;
  const remaining = (): number => Math.max(1, deadline - Date.now());
  const descriptors: number[] = [];
  const command = async (args: string[], timeout: number): Promise<string> => {
    if (Date.now() >= deadline) throw new Error('Router log capture deadline exceeded');
    const result = await execa('docker', args, {
      cwd: workDir, env: getLocalDockerEnv(), timeout: Math.min(timeout, remaining()),
      killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
    });
    return result.stdout;
  };
  try {
    const found = (await command(['compose', 'ps', '--all', '--quiet', 'router'], 1_000)).trim();
    if (!found) {
      logger.debug('No router container found; skipping router log capture');
      return;
    }
    if (!/^[a-f0-9]{12,64}$/.test(found)) throw new Error('Unexpected router container identity');
    const labels = JSON.parse(await command(['inspect', '--format', '{{json .Config.Labels}}', found], 1_000));
    if (labels?.['com.docker.compose.project'] !== projectName(workDir) ||
        labels?.['com.docker.compose.service'] !== 'router') {
      throw new Error('Router container does not belong to this compose project');
    }
    try {
      await command(['stop', found, '-t', '1'], 1_500);
    } catch (error) {
      logger.warn('Could not stop router before log capture; attempting capture anyway', error);
    }
    const destination = path.resolve(options.routerLogs);
    const unsafeDirs = [
      options.auditDir ?? path.join(workDir, 'audit'),
      options.sessionState ?? path.join(workDir, 'agent-session-state'),
    ];
    for (const unsafe of unsafeDirs) {
      if (overlaps(canonicalPath(destination), canonicalPath(unsafe))) {
        throw new Error('Router log directory overlaps audit or session-state artifacts');
      }
    }
    const fd = secureLogFile(destination, descriptors);
    if (Date.now() >= deadline) throw new Error('Router log capture incomplete: deadline exceeded');
    await new Promise<void>((resolve) => {
      let bytes = 0;
      let done = false;
      const child = execa('docker', ['logs', found], {
        cwd: workDir, env: getLocalDockerEnv(), buffer: false,
        timeout: remaining(), killSignal: 'SIGKILL',
      });
      const finish = (failure?: string): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (failure) {
          child.kill('SIGKILL');
          logger.warn(`Router log capture incomplete: ${failure}`);
        }
        resolve();
      };
      const timer = setTimeout(() => finish('deadline exceeded'), remaining());
      const record = (chunk: Buffer): void => {
        if (done) return;
        if (Date.now() >= deadline) return finish('deadline exceeded');
        try {
          const length = Math.min(chunk.length, ROUTER_LOG_MAX_BYTES - bytes);
          let offset = 0;
          while (offset < length) {
            if (fs.fstatSync(fd).nlink !== 1) throw new Error('Router log file acquired a hardlink');
            const written = fs.writeSync(fd, chunk, offset, length - offset);
            if (written <= 0) throw new Error('Zero-byte write');
            offset += written;
            bytes += written;
          }
          if (length < chunk.length) finish('16 MiB limit exceeded');
        } catch (error) {
          finish(`write failed: ${String(error)}`);
        }
      };
      child.stdout?.on('data', record);
      child.stderr?.on('data', record);
      child.then(() => finish(), error => finish(String(error)));
    });
  } catch (error) {
    logger.warn('Could not capture router logs (capture may be incomplete)', error);
  } finally {
    for (const fd of descriptors.reverse()) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        logger.warn('Could not close router log capture descriptor', error);
      }
    }
  }
}
