// computer-use-mcp.ts — MCP server factory exposing Computer Use tools to
// a worker session. The worker calls these tools to control the desktop:
// screenshot, mouse_click, mouse_move, keyboard_type, keyboard_press, scroll.
//
// Screenshot data is too large for MCP tool results, so the bridge injects
// the PNG into the worker's input queue as an image content block. The tool
// result just confirms dimensions.

import { createSdkMcpServer, tool } from './claude-cli/inproc-mcp.js';
import { z } from 'zod';
import {
  takeScreenshot,
  mouseClick,
  mouseMove,
  keyboardType,
  keyboardPress,
  scroll,
  type MouseButton,
  type ScrollDirection,
  type ScreenshotData,
} from './computer-use.js';

export interface ComputerUseBridge {
  injectScreenshot: (workerId: string, data: ScreenshotData) => void;
}

export function buildComputerUseMcp(bridge: ComputerUseBridge, workerId: string) {
  return createSdkMcpServer({
    name: 'computer-use',
    version: '0.1.0',
    tools: [
      tool(
        'screenshot',
        'Capture a screenshot of the current screen. The image will be injected into your next message as a visible image — analyze it to understand the UI state before taking actions.',
        {
          display: z.number().optional().describe('Display ID to capture. Omit for the primary display.'),
        },
        async ({ display }) => {
          const r = await takeScreenshot(display);
          if (!r.ok) {
            return { content: [{ type: 'text', text: `screenshot failed: ${r.error}` }], isError: true };
          }
          bridge.injectScreenshot(workerId, r.data);
          return {
            content: [{
              type: 'text',
              text: `Screenshot captured (${r.data.width}×${r.data.height}). The image is now visible in your next message — look at it to decide your next action.`,
            }],
          };
        },
      ),

      tool(
        'mouse_click',
        'Click at screen coordinates. Coordinates are in screen pixels (Retina-scaled). Take a screenshot first to identify the target position.',
        {
          x: z.number().describe('X coordinate in screen pixels'),
          y: z.number().describe('Y coordinate in screen pixels'),
          button: z.enum(['left', 'right', 'middle']).default('left').describe('Mouse button'),
          count: z.number().min(1).max(3).default(1).describe('Click count (1=single, 2=double, 3=triple)'),
        },
        async ({ x, y, button, count }) => {
          const r = await mouseClick(x, y, button as MouseButton, count);
          if (!r.ok) {
            return { content: [{ type: 'text', text: r.error }], isError: true };
          }
          return { content: [{ type: 'text', text: `Clicked ${button} at (${x}, ${y})${count > 1 ? ` ×${count}` : ''}` }] };
        },
      ),

      tool(
        'mouse_move',
        'Move the mouse cursor to screen coordinates without clicking.',
        {
          x: z.number().describe('X coordinate in screen pixels'),
          y: z.number().describe('Y coordinate in screen pixels'),
        },
        async ({ x, y }) => {
          const r = await mouseMove(x, y);
          if (!r.ok) {
            return { content: [{ type: 'text', text: r.error }], isError: true };
          }
          return { content: [{ type: 'text', text: `Mouse moved to (${x}, ${y})` }] };
        },
      ),

      tool(
        'keyboard_type',
        'Type text using the keyboard. The text is typed character by character into the currently focused field.',
        {
          text: z.string().min(1).describe('Text to type'),
        },
        async ({ text }) => {
          const r = await keyboardType(text);
          if (!r.ok) {
            return { content: [{ type: 'text', text: r.error }], isError: true };
          }
          const preview = text.length > 40 ? `${text.slice(0, 37)}…` : text;
          return { content: [{ type: 'text', text: `Typed: "${preview}"` }] };
        },
      ),

      tool(
        'keyboard_press',
        'Press a key or key combination. Use for special keys (Return, Tab, Escape, arrow keys) and shortcuts (Cmd+C, Ctrl+A).',
        {
          key: z.string().describe('Key name: return, tab, escape, space, delete, up, down, left, right, home, end, pageup, pagedown, f1-f12, or a single character'),
          modifiers: z.array(z.enum(['command', 'cmd', 'control', 'ctrl', 'option', 'alt', 'shift']))
            .default([])
            .describe('Modifier keys to hold'),
        },
        async ({ key, modifiers }) => {
          const r = await keyboardPress(key, modifiers);
          if (!r.ok) {
            return { content: [{ type: 'text', text: r.error }], isError: true };
          }
          const combo = modifiers.length > 0
            ? `${modifiers.join('+')}+${key}`
            : key;
          return { content: [{ type: 'text', text: `Pressed: ${combo}` }] };
        },
      ),

      tool(
        'scroll',
        'Scroll at a specific screen position. Move the cursor to (x, y) first, then scroll.',
        {
          x: z.number().describe('X coordinate to scroll at'),
          y: z.number().describe('Y coordinate to scroll at'),
          direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
          amount: z.number().min(1).max(20).default(3).describe('Number of scroll lines'),
        },
        async ({ x, y, direction, amount }) => {
          const r = await scroll(x, y, direction as ScrollDirection, amount);
          if (!r.ok) {
            return { content: [{ type: 'text', text: r.error }], isError: true };
          }
          return { content: [{ type: 'text', text: `Scrolled ${direction} ${amount} lines at (${x}, ${y})` }] };
        },
      ),
    ],
  });
}
