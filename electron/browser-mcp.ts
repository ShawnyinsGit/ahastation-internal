// browser-mcp.ts — MCP server factory exposing browser tools to worker sessions.
// Workers use these tools to control the embedded browser: navigate, screenshot,
// click, type, press keys, scroll, execute JavaScript, get page content.
//
// Screenshot data is injected into the worker's input queue (same pattern as
// computer-use) since PNG data is too large for MCP tool results.

import { createSdkMcpServer, tool } from './claude-cli/inproc-mcp.js';
import { z } from 'zod';
import { BrowserTabManager } from './browser-tab-manager.js';

export interface BrowserMcpBridge {
  injectScreenshot: (workerId: string, data: { pngBase64: string; width: number; height: number }) => void;
}

export function buildBrowserMcp(
  browserManager: BrowserTabManager,
  bridge: BrowserMcpBridge,
  workerId: string,
) {
  return createSdkMcpServer({
    name: 'browser',
    version: '0.1.0',
    tools: [
      tool(
        'browser_navigate',
        'Navigate the embedded browser to a URL. Use this to load web pages for inspection or interaction.',
        {
          url: z.string().url().describe('Full URL to navigate to (must include protocol, e.g. https://example.com)'),
        },
        async ({ url }) => {
          const activeTabId = browserManager.snapshot().activeTabId;
          if (!activeTabId) {
            // Auto-open a tab if none exists
            const tab = await browserManager.openTab(url);
            return { content: [{ type: 'text', text: `Opened new tab and navigated to ${url}` }] };
          }
          const result = await browserManager.navigate(activeTabId, url);
          if (!result.ok) {
            return { content: [{ type: 'text', text: `Failed to navigate to ${url}` }], isError: true };
          }
          return { content: [{ type: 'text', text: `Navigated to ${url}` }] };
        },
      ),

      tool(
        'browser_screenshot',
        'Capture a screenshot of the embedded browser page. The image will be injected into your next message — analyze it to understand the page content before taking actions.',
        {},
        async () => {
          const data = await browserManager.capturePage();
          if (!data) {
            return { content: [{ type: 'text', text: 'Failed to capture browser screenshot' }], isError: true };
          }
          bridge.injectScreenshot(workerId, data);
          return {
            content: [{
              type: 'text',
              text: `Browser screenshot captured (${data.width}×${data.height}). The image is now visible in your next message — examine it to understand the page state.`,
            }],
          };
        },
      ),

      tool(
        'browser_click',
        'Click at coordinates within the embedded browser page. Take a screenshot first to identify the target position.',
        {
          x: z.number().describe('X coordinate in page pixels'),
          y: z.number().describe('Y coordinate in page pixels'),
          button: z.enum(['left', 'right', 'middle']).default('left').describe('Mouse button'),
          count: z.number().min(1).max(3).default(1).describe('Click count (1=single, 2=double, 3=triple)'),
        },
        async ({ x, y, button, count }) => {
          const ok = await browserManager.sendInputEvent({
            type: 'mouseDown',
            x,
            y,
            button,
            clickCount: count,
          });
          if (!ok) {
            return { content: [{ type: 'text', text: `Failed to click at (${x}, ${y})` }], isError: true };
          }
          return { content: [{ type: 'text', text: `Clicked ${button} at (${x}, ${y})${count > 1 ? ` ×${count}` : ''}` }] };
        },
      ),

      tool(
        'browser_type',
        'Type text into the currently focused element in the embedded browser.',
        {
          text: z.string().min(1).describe('Text to type'),
        },
        async ({ text }) => {
          const ok = await browserManager.sendKeys(text);
          if (!ok) {
            return { content: [{ type: 'text', text: 'Failed to type text' }], isError: true };
          }
          const preview = text.length > 40 ? `${text.slice(0, 37)}…` : text;
          return { content: [{ type: 'text', text: `Typed: "${preview}"` }] };
        },
      ),

      tool(
        'browser_press_key',
        'Press a key or key combination in the embedded browser. Use for special keys (Return, Tab, Escape) and shortcuts.',
        {
          key: z.string().describe('Key name: return, tab, escape, space, delete, up, down, left, right, home, end, pageup, pagedown, f1-f12, or a single character'),
          modifiers: z.array(z.enum(['command', 'cmd', 'control', 'ctrl', 'option', 'alt', 'shift']))
            .default([])
            .describe('Modifier keys to hold'),
        },
        async ({ key, modifiers }) => {
          const ok = await browserManager.sendKey(key, modifiers);
          if (!ok) {
            return { content: [{ type: 'text', text: `Failed to press ${key}` }], isError: true };
          }
          const combo = modifiers.length > 0
            ? `${modifiers.join('+')}+${key}`
            : key;
          return { content: [{ type: 'text', text: `Pressed: ${combo}` }] };
        },
      ),

      tool(
        'browser_scroll',
        'Scroll the embedded browser page at a specific position.',
        {
          x: z.number().describe('X coordinate to scroll at'),
          y: z.number().describe('Y coordinate to scroll at'),
          direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
          amount: z.number().min(1).max(20).default(3).describe('Number of scroll lines'),
        },
        async ({ x, y, direction, amount }) => {
          const ok = await browserManager.scroll(x, y, direction, amount);
          if (!ok) {
            return { content: [{ type: 'text', text: `Failed to scroll ${direction}` }], isError: true };
          }
          return { content: [{ type: 'text', text: `Scrolled ${direction} ${amount} lines at (${x}, ${y})` }] };
        },
      ),

      tool(
        'browser_evaluate',
        'Execute JavaScript code in the embedded browser page context. Use for reading page data, manipulating DOM, or calling page functions.',
        {
          code: z.string().min(1).describe('JavaScript code to execute'),
        },
        async ({ code }) => {
          const result = await browserManager.executeJavaScript(code);
          if (result.error) {
            return { content: [{ type: 'text', text: `JavaScript error: ${result.error}` }], isError: true };
          }
          return { content: [{ type: 'text', text: `Result: ${JSON.stringify(result.value)}` }] };
        },
      ),

      tool(
        'browser_get_content',
        'Get the visible text content of the embedded browser page. Useful for reading page content without screenshots.',
        {
          selector: z.string().optional().describe('CSS selector to target specific element (defaults to body)'),
        },
        async ({ selector }) => {
          const content = await browserManager.getPageText(selector);
          if (!content) {
            return { content: [{ type: 'text', text: 'Failed to get page content' }], isError: true };
          }
          const preview = content.length > 500 ? `${content.slice(0, 497)}…` : content;
          return { content: [{ type: 'text', text: `Page content:\n${preview}` }] };
        },
      ),
    ],
  });
}
