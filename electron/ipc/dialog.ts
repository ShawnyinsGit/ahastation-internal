import { ipcMain, dialog } from 'electron';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { listSubdirs } from '../dir-list.js';
import type { IpcContext } from './context.js';

const MAX_PATH_LENGTH = 4096;

// S6: surface the implicit grant. Picking a folder hands every Worker in
// the meeting Read/Write/Bash access to that path and all subdirectories.
// We want one moment of friction here so the user isn't surprised when a
// Worker starts modifying files later.
// Re-fetch liveWindow because the pick is async — the user may have cmd-Q'd
// between picking and confirming.
async function confirmCwdGrant(ctx: IpcContext, picked: string): Promise<string | null> {
  const winConfirm = ctx.liveWindow();
  if (!winConfirm) return null;
  const confirm = await dialog.showMessageBox(winConfirm, {
    type: 'warning',
    title: '确认工作目录',
    message: 'Worker 将获得文件和命令行访问权限',
    detail:
      `AhaStation 的 Worker 将可以在以下目录中读取、写入文件和执行命令：\n\n${picked}\n\n` +
      '包括所有子目录。除非你在设置中启用自动批准，否则每次工具调用仍需你确认。',
    buttons: ['取消', '确认'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (confirm.response !== 1) return null;
  return picked;
}

export function registerDialogIpc(ctx: IpcContext): void {
  ipcMain.handle('dialog:pick-cwd', async () => {
    const win = ctx.liveWindow();
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      defaultPath: homedir(),
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return confirmCwdGrant(ctx, res.filePaths[0]);
  });

  // Grant confirmation only — used by the in-app directory picker (handheld
  // mode), which browses via dialog:list-dir and then confirms here so both
  // flows end at the identical warning messagebox.
  ipcMain.handle('dialog:confirm-cwd', async (_event, payload) => {
    const picked =
      typeof payload === 'object' && payload !== null
        ? (payload as { path?: unknown }).path
        : null;
    if (typeof picked !== 'string' || picked.length === 0 || picked.length > MAX_PATH_LENGTH) {
      return null;
    }
    return confirmCwdGrant(ctx, picked);
  });

  // Directory listing for the in-app picker: subdirectories only, sorted by
  // name; dot-prefixed entries hidden unless showHidden. A null/omitted path
  // starts at the home directory.
  ipcMain.handle('dialog:list-dir', async (_event, payload) => {
    const raw =
      typeof payload === 'object' && payload !== null
        ? (payload as { path?: unknown; showHidden?: unknown })
        : {};
    if (raw.path !== undefined && raw.path !== null && typeof raw.path !== 'string') {
      return { ok: false, error: '无效的路径' };
    }
    const path = typeof raw.path === 'string' ? raw.path : null;
    if (path !== null && (path.length === 0 || path.length > MAX_PATH_LENGTH)) {
      return { ok: false, error: '无效的路径' };
    }
    const showHidden = raw.showHidden === true;
    const target = resolve(path ?? homedir());
    try {
      const entries = await listSubdirs(target, showHidden);
      const parent = dirname(target);
      return {
        ok: true,
        path: target,
        parent: parent === target ? null : parent,
        entries,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return {
        ok: false,
        error: code === 'EACCES' || code === 'EPERM' ? '没有权限访问该目录' : '无法读取该目录',
      };
    }
  });
}
