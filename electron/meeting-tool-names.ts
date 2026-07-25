// meeting-tool-names.ts — the meeting tool vocabulary, split out of
// meeting-tools.ts so the renderer can recognize tool calls without pulling in
// the main-process plan compiler (which reaches node:fs through task-intent).

export const MEETING_TOOLS = {
  DELEGATE: 'delegate_task',
  UPDATE: 'update_task',
  STATUS: 'ask_worker_status',
  NARRATE: 'narrate_to_user',
  PLAN_MEETING: 'plan_meeting',
  DELEGATE_TO: 'delegate_to',
  SEND_TASK_MESSAGE: 'send_task_message',
  FOLLOW_UP_TASK: 'follow_up_task',
  STEER_TASK: 'steer_task',
  INTERRUPT_TASK: 'interrupt_task',
  FORWARD_TASK_MESSAGE: 'forward_task_message',
  INSPECT_DELIVERY_REVIEW: 'inspect_delivery_review',
  GET_DELIVERY_REVIEW_CHUNK: 'get_delivery_review_chunk',
  SUBMIT_DELIVERY_CHUNK_REVIEW: 'submit_delivery_chunk_review',
  COMPLETE_DELIVERY_REVIEW: 'complete_delivery_review',
  REQUEST_DELIVERY_REWORK: 'request_delivery_rework',
  ASK_COORDINATOR: 'ask_coordinator',
  TASK_DONE: 'task_done',
  SUBMIT_WORK_REPORT: 'submit_work_report',
  SUBMIT_DELIVERY: 'submit_delivery',
  REQUEST_DECISION: 'request_user_decision',
  ASK_HOST: 'ask_host',
  REPLY_COORDINATOR: 'reply_to_coordinator',
  OBSERVED_SESSIONS_LIST: 'observed_sessions_list',
  OBSERVED_SESSION_FOCUS: 'observed_session_focus',
  OBSERVED_SESSION_SEND_TEXT: 'observed_session_send_text',
} as const;

export type MeetingToolName = (typeof MEETING_TOOLS)[keyof typeof MEETING_TOOLS];

export const MEETING_TOOL_NAMES: ReadonlySet<string> = new Set<string>(
  Object.values(MEETING_TOOLS),
);
