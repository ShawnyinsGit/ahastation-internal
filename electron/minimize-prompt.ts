// minimize-prompt.ts — pure decision logic for the minimize/close → AhaBar
// prompt. Kept electron-free so node --test can exercise it directly; main.ts
// wires the outcomes to real BrowserWindow calls.

export type MinimizePromptKind = 'minimize' | 'close';

export interface MinimizeChoice {
  action: 'ahabar' | 'hide';
  never: boolean;
}

export type MinimizeOutcome =
  | 'open-ahabar-minimize'
  | 'open-ahabar-hide'
  | 'minimize'
  | 'close';

/** Whether intercepting a minimize/close to ask about AhaBar makes sense.
 *  No point asking when the bar is already floating or the user checked
 *  不再提示; during app quit the close path must stay untouched. */
export function shouldPromptMinimize(input: {
  ahaBarOpen: boolean;
  promptDisabled: boolean;
  quitting: boolean;
}): boolean {
  return !input.quitting && !input.ahaBarOpen && !input.promptDisabled;
}

/** Map the user's choice onto the concrete window action. 'ahabar' floats the
 *  bar first, then minimizes (minimize path) or hides the window (close path —
 *  hiding instead of destroying keeps live sessions and the voice link up,
 *  which is the whole point of enabling the bar). 'hide' replays the original
 *  minimize/close semantics unchanged. */
export function resolveMinimizeOutcome(
  kind: MinimizePromptKind,
  choice: MinimizeChoice,
): MinimizeOutcome {
  if (choice.action === 'ahabar') {
    return kind === 'minimize' ? 'open-ahabar-minimize' : 'open-ahabar-hide';
  }
  return kind === 'minimize' ? 'minimize' : 'close';
}
