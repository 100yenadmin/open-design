import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyOwnedProjectContent, ownedContentFingerprint } from '../../src/collab/owned-content-files.js';
import type { OwnedContentScope } from '../../src/collab/owned-content-store.js';

const scope: OwnedContentScope = { projectId: 'owner-files', workspaceId: 'w1', resourceTeamId: 'w1', viewerMemberId: 'owner', ownerMemberId: 'owner' };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'od-owner-files-'));
  const live = path.join(root, scope.projectId);
  await mkdir(live);
  await writeFile(path.join(live, 'index.html'), '<h1>local</h1>');
  const authorize = vi.fn(async () => {});
  const commit = vi.fn(async () => {});
  const options = {
    projectsRoot: root, scope, expectedVersion: 2, authorize, isBusy: () => false, commit,
    run: async (args: string[]) => {
      await writeFile(path.join(args[3]!, 'index.html'), '<h1>remote</h1>');
      return JSON.stringify({ version: 2 });
    },
  };
  return { root, live, options, authorize, commit, close: () => rm(root, { recursive: true, force: true }) };
}

describe('owner content materialization', () => {
  it('keeps local private entries, strips remote private entries, and records both HTML versions', async () => {
    const f = await fixture();
    try {
      await mkdir(path.join(f.live, 'nested', '.git'), { recursive: true });
      await writeFile(path.join(f.live, 'nested', '.git', 'config'), 'local identity');
      const result = await applyOwnedProjectContent({ ...f.options, run: async args => {
        await f.options.run(args);
        await mkdir(path.join(args[3]!, '.git'));
        await writeFile(path.join(args[3]!, '.git', 'config'), 'remote identity');
        return JSON.stringify({ version: 2 });
      } });
      expect(await readFile(path.join(f.live, 'index.html'), 'utf8')).toBe('<h1>remote</h1>');
      expect(await readFile(path.join(f.live, 'nested', '.git', 'config'), 'utf8')).toBe('local identity');
      await expect(readFile(path.join(f.live, '.git', 'config'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(result.fingerprint).toBe(await ownedContentFingerprint(f.live));
      expect(f.authorize).toHaveBeenCalledTimes(2);
      expect(f.commit).toHaveBeenCalledWith(2);
    } finally { await f.close(); }
  });

  it('falls back to the legacy unscoped resource id when the scoped resource is missing', async () => {
    const f = await fixture();
    const resourceIds: string[] = [];
    try {
      const result = await applyOwnedProjectContent({ ...f.options, run: async args => {
        resourceIds.push(args[2]!);
        if (resourceIds.length === 1) throw new Error('resource_not_found');
        return f.options.run(args);
      } });
      expect(resourceIds).toHaveLength(2);
      expect(resourceIds[0]).not.toBe(`project-${scope.projectId}`);
      expect(resourceIds[1]).toBe(`project-${scope.projectId}`);
      expect(result.version).toBe(2);
      expect(await readFile(path.join(f.live, 'index.html'), 'utf8')).toBe('<h1>remote</h1>');
    } finally { await f.close(); }
  });

  it.each(['stale', 'revoked', 'busy', 'commit', 'history', 'symlink', 'private-conflict'])('fails %s without replacing local content', async failure => {
    const f = await fixture();
    try {
      if (failure === 'revoked') f.authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'));
      if (failure === 'commit') f.commit.mockRejectedValueOnce(new Error('registration failed'));
      if (failure === 'history') await symlink(f.root, path.join(f.live, '.file-versions'));
      if (failure === 'private-conflict') {
        await mkdir(path.join(f.live, 'nested', '.git'), { recursive: true });
        await writeFile(path.join(f.live, 'nested', '.git', 'config'), 'preserve me');
      }
      await expect(applyOwnedProjectContent({ ...f.options,
        isBusy: () => failure === 'busy',
        run: async args => {
          await f.options.run(args);
          if (failure === 'symlink') await symlink(f.root, path.join(args[3]!, 'public-link'));
          if (failure === 'private-conflict') await writeFile(path.join(args[3]!, 'nested'), 'remote file');
          return JSON.stringify({ version: failure === 'stale' ? 3 : 2 });
        },
      })).rejects.toThrow();
      expect(await readFile(path.join(f.live, 'index.html'), 'utf8')).toBe('<h1>local</h1>');
      if (failure !== 'commit') expect(f.commit).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});
