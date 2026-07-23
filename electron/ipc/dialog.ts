import { ipcMain, dialog } from 'electron';
import { homedir } from 'node:os';
import type { IpcContext } from './context.js';

export function registerDialogIpc(ctx: IpcContext): void {
  ipcMain.handle('dialog:pick-cwd', async () => {
    const win = ctx.liveWindow();
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      defaultPath: homedir(),
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const picked = res.filePaths[0];
    // S6: surface the implicit grant. Picking a folder hands every Worker in
    // the meeting Read/Write/Bash access to that path and all subdirectories.
    // We want one moment of friction here so the user isn't surprised when a
    // Worker starts modifying files later.
    // Re-fetch liveWindow because the showOpenDialog above is async — the user
    // may have cmd-Q'd between picking and confirming.
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
  });
}
