import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

/** Use the retained runtime, and acknowledge native startup rather than just a successful spawn. */
export async function startRadar(workspace: string, cli: string, timeoutMs = 8000): Promise<'started' | 'running'> {
  const helper = path.resolve(path.dirname(cli), '../../bin/kith-menubar');
  if (!fs.existsSync(helper)) throw new Error('Menu-bar helper is missing; reinstall Kith or build it with pnpm build:menubar.');
  const target = fs.realpathSync(workspace);
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [target, process.execPath, cli, '--ready'], {detached: true, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', errors = '', settled = false;
    const finish = (error?: Error, state?: 'started' | 'running') => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      if (error) { child.kill(); reject(error); } else resolve(state!);
    };
    const timer = setTimeout(() => finish(new Error('Timed out waiting for the menu-bar view to open.')), timeoutMs);
    child.once('error', error => finish(error));
    child.once('close', code => finish(new Error(errors.trim() || `Menu-bar helper exited before opening (${code}).`)));
    child.stderr.on('data', bytes => { errors = (errors + bytes.toString()).slice(-2048); });
    child.stdout.on('data', bytes => {
      output += bytes.toString();
      const line = output.split('\n')[0];
      if (output.includes('\n')) {
        if (line === 'KITH_RADAR_STARTED') finish(undefined, 'started');
        else if (line === 'KITH_RADAR_RUNNING') finish(undefined, 'running');
        else finish(new Error('Menu-bar helper returned an invalid startup acknowledgement.'));
      } else if (output.length > 2048) finish(new Error('Menu-bar helper returned excessive startup output.'));
    });
  });
}
