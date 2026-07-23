// computer-use.ts — low-level macOS automation primitives for the Computer Use
// integration. Zero external dependencies: screenshots via Electron's
// desktopCapturer, mouse/keyboard/scroll via JXA (osascript -l JavaScript).
//
// Every action checks accessibility permission before executing and returns a
// typed result so the MCP layer can surface permission errors to the worker.

import { desktopCapturer, screen, systemPreferences } from 'electron';
import { spawn } from 'node:child_process';

export interface ActionOk<T = void> {
  ok: true;
  data: T;
}

export interface ActionErr {
  ok: false;
  error: string;
  needsPermission?: 'accessibility';
}

export type ActionResult<T = void> = ActionOk<T> | ActionErr;

export interface ScreenshotData {
  pngBase64: string;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Platform guard — Computer Use relies on macOS-only osascript (JXA).
// On Windows/Linux, isAccessibilityGranted() returns false — Computer Use is
// macOS-only — and every action returns an error before reaching osascript.

function platformGuard(): ActionErr | null {
  if (process.platform === 'darwin') return null;
  return { ok: false, error: 'Computer Use is only available on macOS' };
}

// ---------------------------------------------------------------------------
// Accessibility permission gate

export function isAccessibilityGranted(): boolean {
  if (process.platform !== 'darwin') return false;
  return systemPreferences.isTrustedAccessibilityClient(false);
}

export function requestAccessibility(): boolean {
  if (process.platform !== 'darwin') return false;
  return systemPreferences.isTrustedAccessibilityClient(true);
}

function requireAccessibility(): ActionErr | null {
  if (isAccessibilityGranted()) return null;
  return {
    ok: false,
    error: 'Accessibility permission not granted. Open System Settings → Privacy & Security → Accessibility and enable AhaStation.',
    needsPermission: 'accessibility',
  };
}

// ---------------------------------------------------------------------------
// Screenshot — uses Electron desktopCapturer, no accessibility needed

export async function takeScreenshot(displayId?: number): Promise<ActionResult<ScreenshotData>> {
  const pGuard = platformGuard();
  if (pGuard) return pGuard;
  try {
    const displays = screen.getAllDisplays();
    const target = displayId != null
      ? displays.find((d) => d.id === displayId) ?? displays[0]
      : screen.getPrimaryDisplay();

    if (!target) {
      return { ok: false, error: 'No display found' };
    }

    const scaleFactor = target.scaleFactor || 1;
    const logicalWidth = target.size.width;
    const logicalHeight = target.size.height;
    const pixelWidth = logicalWidth * scaleFactor;
    const pixelHeight = logicalHeight * scaleFactor;

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: pixelWidth, height: pixelHeight },
    });

    const displayIdStr = String(target.id);
    const source = sources.find((s) => s.display_id === displayIdStr) ?? sources[0];
    if (!source) {
      return { ok: false, error: 'No screen source available — check Screen Recording permission' };
    }

    const thumbnail = source.thumbnail;
    if (thumbnail.isEmpty()) {
      return { ok: false, error: 'Screenshot returned empty — Screen Recording permission may be denied' };
    }

    const pngBuffer = thumbnail.toPNG();
    const size = thumbnail.getSize();

    return {
      ok: true,
      data: {
        pngBase64: pngBuffer.toString('base64'),
        width: size.width,
        height: size.height,
      },
    };
  } catch (err) {
    return { ok: false, error: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// JXA execution helper

function runJxa(script: string): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn('osascript', ['-l', 'JavaScript', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    // 30s timeout — osascript can hang on modal dialogs, JXA infinite loops,
    // or CoreGraphics deadlocks. Without this the worker stalls forever.
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      resolve({ ok: false, error: 'JXA execution timed out (30s)' });
    }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (err: Error) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, stdout: stdout.trim() });
      else resolve({ ok: false, error: stderr.trim() || `osascript exited ${code}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Mouse actions

export type MouseButton = 'left' | 'right' | 'middle';

export async function mouseClick(
  x: number,
  y: number,
  button: MouseButton = 'left',
  clickCount: number = 1,
): Promise<ActionResult> {
  const pGuard = platformGuard();
  if (pGuard) return pGuard;
  const permErr = requireAccessibility();
  if (permErr) return permErr;

  const scaleFactor = screen.getPrimaryDisplay().scaleFactor || 1;
  const px = Math.round(x / scaleFactor);
  const py = Math.round(y / scaleFactor);

  const eventType = button === 'right' ? 'rightMouseDown' : 'leftMouseDown';
  const eventTypeUp = button === 'right' ? 'rightMouseUp' : 'leftMouseUp';
  const cgButton = button === 'right' ? 1 : 0;

  const script = `
    ObjC.import('CoreGraphics');
    var point = $.CGPointMake(${px}, ${py});
    ${Array.from({ length: clickCount }, (_, i) => `
    var down${i} = $.CGEventCreateMouseEvent(null, $.k${capitalize(eventType)}, point, ${cgButton});
    $.CGEventSetIntegerValueField(down${i}, $.kCGMouseEventClickState, ${i + 1});
    $.CGEventPost($.kCGHIDEventTap, down${i});
    var up${i} = $.CGEventCreateMouseEvent(null, $.k${capitalize(eventTypeUp)}, point, ${cgButton});
    $.CGEventSetIntegerValueField(up${i}, $.kCGMouseEventClickState, ${i + 1});
    $.CGEventPost($.kCGHIDEventTap, up${i});
    `).join('\n')}
    delay(0.05);
  `;

  const r = await runJxa(script);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, data: undefined };
}

export async function mouseMove(x: number, y: number): Promise<ActionResult> {
  const pGuard = platformGuard();
  if (pGuard) return pGuard;
  const permErr = requireAccessibility();
  if (permErr) return permErr;

  const scaleFactor = screen.getPrimaryDisplay().scaleFactor || 1;
  const px = Math.round(x / scaleFactor);
  const py = Math.round(y / scaleFactor);

  const script = `
    ObjC.import('CoreGraphics');
    var point = $.CGPointMake(${px}, ${py});
    var event = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, point, 0);
    $.CGEventPost($.kCGHIDEventTap, event);
  `;

  const r = await runJxa(script);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Keyboard actions

const KEY_MAP: Record<string, number> = {
  return: 36, enter: 36, tab: 9, space: 49, delete: 51, backspace: 51,
  escape: 53, esc: 53,
  up: 126, down: 125, left: 123, right: 124,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};

export async function keyboardType(text: string): Promise<ActionResult> {
  const pGuard = platformGuard();
  if (pGuard) return pGuard;
  const permErr = requireAccessibility();
  if (permErr) return permErr;

  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\t/g, '\\t')
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

  const script = `
    var se = Application('System Events');
    se.keystroke("${escaped}");
  `;

  const r = await runJxa(script);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, data: undefined };
}

export async function keyboardPress(
  key: string,
  modifiers: string[] = [],
): Promise<ActionResult> {
  const pGuard = platformGuard();
  if (pGuard) return pGuard;
  const permErr = requireAccessibility();
  if (permErr) return permErr;

  const keyLower = key.toLowerCase();
  const keyCode = KEY_MAP[keyLower];

  const modMap: Record<string, string> = {
    command: 'command down', cmd: 'command down',
    control: 'control down', ctrl: 'control down',
    option: 'option down', alt: 'option down',
    shift: 'shift down',
  };
  const modList = modifiers
    .map((m) => modMap[m.toLowerCase()])
    .filter(Boolean);
  const usingClause = modList.length > 0
    ? ` using {${modList.join(', ')}}`
    : '';

  let script: string;
  if (keyCode != null) {
    script = `
      var se = Application('System Events');
      se.keyCode(${keyCode}${usingClause});
    `;
  } else if (keyLower.length === 1) {
    // Escape for JXA string literal — same rules as keyboardType
    const safeKey = keyLower
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    script = `
      var se = Application('System Events');
      se.keystroke("${safeKey}"${usingClause});
    `;
  } else {
    return { ok: false, error: `Unknown key: "${key}". Use a single character or one of: ${Object.keys(KEY_MAP).join(', ')}` };
  }

  const r = await runJxa(script);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Scroll

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export async function scroll(
  x: number,
  y: number,
  direction: ScrollDirection,
  amount: number = 3,
): Promise<ActionResult> {
  const pGuard = platformGuard();
  if (pGuard) return pGuard;
  const permErr = requireAccessibility();
  if (permErr) return permErr;

  const scaleFactor = screen.getPrimaryDisplay().scaleFactor || 1;
  const px = Math.round(x / scaleFactor);
  const py = Math.round(y / scaleFactor);

  const dy = direction === 'up' ? amount : direction === 'down' ? -amount : 0;
  const dx = direction === 'left' ? amount : direction === 'right' ? -amount : 0;

  const script = `
    ObjC.import('CoreGraphics');
    var point = $.CGPointMake(${px}, ${py});
    var move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, point, 0);
    $.CGEventPost($.kCGHIDEventTap, move);
    var scroll = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 2, ${dy}, ${dx});
    $.CGEventPost($.kCGHIDEventTap, scroll);
  `;

  const r = await runJxa(script);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Helpers

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
