import { getBackendRegistry } from './backends/registry.js';
import { getSettings } from './store.js';

/** Worker executor default when a plan task omits executorBackendId. Host
 *  backend (coordinator) stays separate — e.g. claude-code talker with
 *  claude-code-terminal workers. */
export function resolveDefaultWorkerBackendId(hostBackendId: string): string {
  // Workers are forced to the interactive TUI backend when available. The
  // headless claude-code path stays reserved for the host/coordinator (which
  // needs coordinate:true); workers always run as supervised TUIs. If the
  // terminal backend is unavailable, fall back to the host backend so
  // validateExecutionBackends can surface a clear error instead of silently
  // running headless.
  const terminal = getBackendRegistry().get('claude-code-terminal');
  if (terminal?.capabilities.executeTasks) return 'claude-code-terminal';
  return hostBackendId;
}
