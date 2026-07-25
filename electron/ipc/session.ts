// session:* IPC handlers — per-meeting operations targeting a specific
// SessionSlot identified by `payload.sessionId`. When the renderer omits the
// id (legacy / global-hotkey callers), the registry falls back to the active
// slot via `resolve(undefined) === getActive()`. session:start is gone —
// opening a meeting goes through `sessions:open` now (see ipc/sessions.ts).

import { BrowserWindow, dialog, ipcMain } from 'electron';
import { formatError } from '../format-error.js';
import type { AutoApproveScope } from '../auto-approve-policy.js';
import type { IpcContext } from './context.js';
import { saveImageToMaterials } from '../materials.js';
import { z } from 'zod';
import { planMeetingTaskSchema } from '../meeting-tools.js';

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const);
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as Set<string>).has(v);
}

// Renderer payloads (post-multi-tab) all share an optional `sessionId`. Helper
// pulls it out safely and lets caller forward an unknown payload through.
function pickSessionId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const id = (payload as { sessionId?: unknown }).sessionId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function deliveryDecisionPayload(payload: unknown, candidateRequired = true):
  | { ok: true; sessionId?: string; deliveryId: string; candidateId?: string }
  | { ok: false; error: string } {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid payload' };
  const value = payload as Record<string, unknown>;
  const deliveryId = typeof value.deliveryId === 'string' ? value.deliveryId : '';
  const candidateId = typeof value.candidateId === 'string' ? value.candidateId : '';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(deliveryId) || (candidateRequired ? !uuid.test(candidateId) : Boolean(candidateId) && !uuid.test(candidateId))) {
    return { ok: false, error: 'invalid delivery identity' };
  }
  return {
    ok: true,
    sessionId: pickSessionId(payload),
    deliveryId,
    ...(candidateId ? { candidateId } : {}),
  };
}

export function registerSessionIpc(ctx: IpcContext): void {
  ipcMain.handle('session:set-orchestration-mode', async (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid payload' };
    const enabled = (payload as { enabled?: unknown }).enabled;
    if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled must be boolean' };
    const slot = ctx.registry.resolve(pickSessionId(payload));
    if (!slot) return { ok: false, error: 'No active session' };
    slot.orchestrator.setAutoOrchestration(enabled);
    return { ok: true };
  });

  ipcMain.handle('session:approve-plan', async (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid payload' };
    const approved = (payload as { approved?: unknown }).approved;
    if (typeof approved !== 'boolean') return { ok: false, error: 'approved must be boolean' };
    let revisedTasks;
    if ('tasks' in (payload as Record<string, unknown>)) {
      const parsed = z.array(planMeetingTaskSchema).min(1).max(20).safeParse(
        (payload as Record<string, unknown>).tasks,
      );
      if (!parsed.success) return { ok: false, error: 'invalid revised plan' };
      revisedTasks = parsed.data;
    }
    const slot = ctx.registry.resolve(pickSessionId(payload));
    if (!slot) return { ok: false, error: 'No active session' };
    return slot.orchestrator.approvePendingPlan(approved, revisedTasks);
  });

  ipcMain.handle('session:accept-delivery', async (_e, payload: unknown) => {
    const parsed = deliveryDecisionPayload(payload);
    if (!parsed.ok) return parsed;
    if (!parsed.candidateId) return { ok: false, error: 'candidate is required' };
    const slot = ctx.registry.resolve(parsed.sessionId);
    if (!slot) return { ok: false, error: 'No active session' };
    try {
      const delivery = await slot.orchestrator.acceptDelivery(
        parsed.deliveryId,
        parsed.candidateId,
      );
      return { ok: true, delivery };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  });

  ipcMain.handle('session:return-delivery', async (_e, payload: unknown) => {
    const parsed = deliveryDecisionPayload(payload, false);
    if (!parsed.ok) return parsed;
    const feedback = typeof (payload as Record<string, unknown>).feedback === 'string'
      ? String((payload as Record<string, unknown>).feedback).trim()
      : '';
    if (!feedback || feedback.length > 20_000) {
      return { ok: false, error: 'feedback must contain 1-20000 characters' };
    }
    const slot = ctx.registry.resolve(parsed.sessionId);
    if (!slot) return { ok: false, error: 'No active session' };
    try {
      const delivery = await slot.orchestrator.returnDelivery(
        parsed.deliveryId,
        parsed.candidateId,
        feedback,
      );
      return { ok: true, delivery };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  });
  ipcMain.handle('session:user-text', async (_e, payload: { sessionId?: string; text: string }) => {
    const slot = ctx.registry.resolve(pickSessionId(payload));
    if (!slot) return { ok: false, error: 'No active session' };
    const text = typeof payload?.text === 'string' ? payload.text : '';
    if (!text.trim()) return { ok: false, error: 'Text is required' };
    if (text.length > 100_000) return { ok: false, error: 'Text is too large' };
    slot.orchestrator.sendUserText(text);
    ctx.registry.touch(slot.id);
    return { ok: true };
  });

  ipcMain.handle(
    'session:resolve-permission',
    async (_e, payload: {
      sessionId?: string;
      id: string;
      decision: 'allow' | 'deny';
      message?: string;
      scope?: 'worker' | 'task-wide';
    }) => {
      const slot = ctx.registry.resolve(pickSessionId(payload));
      if (!slot) return { ok: false };
      const scope = payload.scope === 'task-wide' ? 'task-wide' : 'worker';
      slot.orchestrator.resolvePermission(payload.id, payload.decision, payload.message, scope);
      return { ok: true };
    },
  );

  ipcMain.handle('session:interrupt', async (_e, payload?: { sessionId?: string }) => {
    const slot = ctx.registry.resolve(pickSessionId(payload));
    // Prefer the live orchestrator. Fall back to a slot's recap-pending state
    // for post-end interrupts (B4); the recap reference is the same
    // Orchestrator instance, so .interrupt() still aborts it.
    const target = slot?.orchestrator ?? null;
    if (!target) return { ok: false };
    await target.interrupt();
    return { ok: true };
  });

  ipcMain.handle(
    'session:set-permission-mode',
    async (_e, payload: { sessionId?: string; mode: unknown }) => {
      const slot = ctx.registry.resolve(pickSessionId(payload));
      if (!slot) return { ok: false, error: 'No active session' };
      if (!isPermissionMode(payload?.mode)) {
        return { ok: false, error: `Invalid permission mode: ${String(payload?.mode)}` };
      }
      if (payload.mode === 'bypassPermissions' && ctx.getAutoApprove() !== 'all') {
        const win = ctx.liveWindow();
        if (!win) return { ok: false, error: 'No window' };
        const result = await dialog.showMessageBox(win, {
          type: 'warning',
          title: '启用跳过权限模式？',
          message: 'SDK 的所有工具调用将跳过权限检查，直接执行。',
          detail: '这与"全自动批准"效果类似——写入、命令执行等都不会再询问。确定要启用吗？',
          buttons: ['取消', '启用'],
          defaultId: 0,
          cancelId: 0,
        });
        if (result.response !== 1) {
          return { ok: false, error: 'cancelled' };
        }
      }
      await slot.orchestrator.setPermissionMode(payload.mode);
      return { ok: true };
    },
  );

  ipcMain.handle('session:set-auto-approve', async (_e, payload: { scope: unknown }) => {
    const VALID_SCOPES = new Set<string>(['off', 'read', 'all']);
    const scope = payload?.scope;
    const next: AutoApproveScope =
      typeof scope === 'string' && VALID_SCOPES.has(scope)
        ? (scope as AutoApproveScope)
        : 'off';

    // S9: scope 'all' lets Claude execute every tool without prompting. A
    // compromised renderer can fire this IPC silently — require a native
    // OS-level confirmation so the elevation can't happen behind the user's
    // back. 'off' and 'read' keep their existing no-prompt behavior.
    // Skip the dialog if already at 'all' — re-sends happen when useEffect
    // re-fires on tab switch / re-render and shouldn't re-prompt.
    if (next === 'all' && ctx.getAutoApprove() !== 'all') {
      const parent = BrowserWindow.getFocusedWindow();
      const result = await dialog.showMessageBox(parent ?? (null as unknown as BrowserWindow), {
        type: 'warning',
        title: '启用自动执行?',
        message: '即将允许 Claude 在不询问的情况下执行所有工具，包括写入、执行命令、修改文件。',
        detail: '只在你完全信任当前任务时启用。会话结束或切回 read/off 可关闭。',
        buttons: ['取消', '启用全自动'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) {
        return { ok: false, error: 'cancelled', autoApproveScope: ctx.getAutoApprove() };
      }
    }

    ctx.setAutoApprove(next);
    // Live-toggle every running orchestrator. We deliberately don't scope
    // auto-approve per slot — switching one tab's mode switches them all so a
    // backgrounded tab can't sneak elevated permissions past a user who
    // thinks they're in dontask mode in the front tab.
    for (const slot of ctx.registry.values()) {
      slot.orchestrator.setAutoApproveScope(next);
    }
    return { ok: true, autoApproveScope: next };
  });

  ipcMain.handle('session:end', async (_e, payload?: { sessionId?: string }) => {
    const slot = ctx.registry.resolve(pickSessionId(payload));
    if (!slot) return { ok: true };
    slot.orchestrator.end();
    // B4: end() fires the recap pass. Mark the slot as recap-pending so a
    // follow-up `session:interrupt` (same sessionId) still reaches the
    // Orchestrator. The slot stays in the registry until the renderer asks
    // to fully close the tab (sessions:close), which drops the entry.
    if (slot.orchestrator.isRecapActive()) {
      slot.recapPending = true;
      const done = slot.orchestrator.recapDonePromise();
      if (done) {
        void done.finally(() => {
          const s = ctx.registry.get(slot.id);
          if (s) s.recapPending = false;
        });
      } else {
        slot.recapPending = false;
      }
    }
    return { ok: true };
  });

  ipcMain.handle(
    'session:user-image',
    async (_e, payload: { sessionId?: string; dataUrl: string; caption: string }) => {
      const slot = ctx.registry.resolve(pickSessionId(payload));
      if (!slot) return { ok: false, error: 'No active session' };
      const dataUrl = typeof payload?.dataUrl === 'string' ? payload.dataUrl : '';
      const caption = typeof payload?.caption === 'string' ? payload.caption : '';
      // S7: validate MIME type against an allowlist so a crafted data URL can't
      // slip unexpected content through to the SDK.
      const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
      const mimeMatch = dataUrl.match(/^data:([^;]+);base64,/);
      if (!mimeMatch || !ALLOWED_MIME.has(mimeMatch[1])) {
        return { ok: false, error: `Unsupported image MIME type: ${mimeMatch?.[1] ?? 'unknown'}` };
      }
      // S7: cap base64 payload at ~15 MB (≈ 11 MB raw). Prevents an OOM-style
      // attack where a renderer compromise feeds a multi-GB string into the SDK.
      const MAX_B64_LEN = 15 * 1024 * 1024;
      const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      if (b64.length > MAX_B64_LEN) {
        return { ok: false, error: `Image too large (${(b64.length / 1024 / 1024).toFixed(1)} MB base64, max ${MAX_B64_LEN / 1024 / 1024} MB)` };
      }
      const mediaType = mimeMatch[1] as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
      try {
        slot.orchestrator.sendUserImage([
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
          { type: 'text', text: caption || 'Here is my current screen. Please take a look.' },
        ]);
        ctx.registry.touch(slot.id);
        if (slot.cwd) {
          saveImageToMaterials({ cwd: slot.cwd, base64: b64, mediaType }).catch((err: unknown) => {
            console.warn('[session] saveImageToMaterials failed:', formatError(err));
          });
        } else {
          console.warn('[session] No cwd available, screenshot not saved to materials');
        }
      } catch (err: unknown) {
        return { ok: false, error: `Send failed: ${formatError(err)}` };
      }
      return { ok: true };
    },
  );
}
