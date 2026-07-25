/* --------------------------------------------------------------------------
 * 统一批准模型 · 风险分级（04 BR-A1 / 03 §4.1）
 * 低=单击 · 中=按住 800ms · 高=详情二次确认 · 禁止快捷=仅完整流程。
 * 现有后端只上报 toolName + input，分级在前端按工具与参数启发式判定；
 * 后端的 auto-approve 三档（off/read/all）照旧生效，与本模型互补。
 * ------------------------------------------------------------------------ */

// NOTE: keep this list in sync with electron/meeting-tool-names.ts — this
// renderer module is transpiled standalone by tests/risk-classify.test.mjs
// (data: URL import), so it cannot import from electron/.
const MEETING_TOOLS = {
  DELEGATE: 'delegate_task',
  DELEGATE_TO: 'delegate_to',
  FOLLOW_UP_TASK: 'follow_up_task',
  STEER_TASK: 'steer_task',
  INTERRUPT_TASK: 'interrupt_task',
  PLAN_MEETING: 'plan_meeting',
} as const;

/** 会议工具全集（低风险的纯状态同步工具）：与 electron/meeting-tool-names.ts 对齐。 */
const MEETING_TOOL_NAMES_SET = new Set<string>([
  'delegate_task', 'update_task', 'ask_worker_status', 'narrate_to_user',
  'plan_meeting', 'delegate_to', 'send_task_message', 'follow_up_task',
  'steer_task', 'interrupt_task', 'forward_task_message',
  'inspect_delivery_review', 'get_delivery_review_chunk',
  'submit_delivery_chunk_review', 'complete_delivery_review',
  'request_delivery_rework', 'ask_coordinator', 'task_done',
  'submit_work_report', 'submit_delivery', 'request_user_decision',
  'ask_host', 'reply_to_coordinator',
  // 观察层只读查询（两个动作工具由 OBSERVED_SESSION_ACTION_TOOLS 先行拦截）
  'observed_sessions_list',
]);

export type RiskLevel = 'low' | 'mid' | 'high' | 'blocked';

export interface RiskAssessment {
  level: RiskLevel;
  /** 动作描述（人话），如「运行命令」「修改文件」。 */
  action: string;
  /** 关键对象（命令 / 文件路径），Mono 展示。 */
  target: string;
  /** 影响说明一句话，如「将修改 node_modules 与 lock 文件」。 */
  impact: string;
  /** 影响面清单（P5 详情页逐条列出）。 */
  impactList: string[];
}

const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch',
  'read_file', 'list_files', 'search',
]);

const WRITE_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write_file', 'edit_file', 'apply_patch',
]);

const SHELL_TOOLS = new Set(['Bash', 'shell', 'run_command', 'execute_command', 'terminal']);

/** 禁止快捷批准级：不可逆/系统级破坏，只能走完整流程（BR-A1 第四级）。 */
const BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(\/|~|\$HOME)(\s|$)/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+.*of=\/dev\//i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bchmod\s+-R\s+777\s+\//,
  />\s*\/dev\/sd[a-z]/,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i,
];

/** 高风险：破坏性但可限定范围的动作。 */
const HIGH_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*r/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b/i,
  /\bdrop\s+table\b|\bdelete\s+from\b/i,
  /\bkill(all)?\s+-9\b/i,
  /\bchmod\b|\bchown\b/i,
];

function shellCommand(input: Record<string, unknown>): string {
  const cmd = input.command ?? input.cmd ?? input.input ?? '';
  return typeof cmd === 'string' ? cmd : String(cmd);
}

function filePathOf(input: Record<string, unknown>): string {
  const p = input.file_path ?? input.path ?? input.filePath ?? '';
  return typeof p === 'string' ? p : String(p);
}

/** Host 语音指令路由工具：聚焦/向观察到的外部窗口输入。目标描述由 Host
 *  解析后填进 targetDescription（如「向 ahakeyconfig 的 Kimi 窗口发送输入」），
 *  卡片直接展示这句话。 */
const OBSERVED_SESSION_ACTION_TOOLS: Record<string, { action: string; impact: string; impactList: string[] }> = {
  mcp__meeting__observed_session_send_text: {
    action: '向观察到的窗口发送输入',
    impact: '文字将直接敲进该终端并回车一次，可能派发任务或批准权限提示',
    impactList: [
      '输入目标：该会话终端的 tty',
      '文本经控制字符过滤、最多 500 字，末尾恰好一个回车',
    ],
  },
  mcp__meeting__observed_session_focus: {
    action: '聚焦观察到的窗口',
    impact: '将把 owning 终端窗口带到前台（无 tty 的桌面线程则打开对应应用）',
    impactList: ['仅切换前台窗口，不输入任何内容'],
  },
};

function observedSessionTarget(input: Record<string, unknown>): string {
  const described = input.targetDescription;
  if (typeof described === 'string' && described.trim()) return described;
  return typeof input.id === 'string' ? input.id : '';
}

export function assessRisk(toolName: string, input: Record<string, unknown>): RiskAssessment {
  if (READ_ONLY_TOOLS.has(toolName)) {
    const target = filePathOf(input) || String(input.pattern ?? input.query ?? input.url ?? '');
    return {
      level: 'low',
      action: '读取信息',
      target,
      impact: '只读操作，不修改任何文件',
      impactList: ['只读访问，无外部副作用'],
    };
  }

  if (WRITE_TOOLS.has(toolName)) {
    const target = filePathOf(input);
    return {
      level: 'mid',
      action: toolName === 'Write' || toolName === 'write_file' ? '写入文件' : '修改文件',
      target,
      impact: `将修改 ${target || '项目文件'}`,
      impactList: [`变更文件：${target || '（未知路径）'}`],
    };
  }

  if (SHELL_TOOLS.has(toolName)) {
    const cmd = shellCommand(input);
    const impactList = [`执行命令：${cmd || '（空命令）'}`];
    if (BLOCKED_PATTERNS.some((re) => re.test(cmd))) {
      return {
        level: 'blocked',
        action: '运行命令',
        target: cmd,
        impact: '该命令具有系统级/不可逆破坏风险，必须走完整确认流程',
        impactList: [...impactList, '命中系统级危险模式（提权/整盘删除/远程脚本执行等）'],
      };
    }
    if (HIGH_PATTERNS.some((re) => re.test(cmd))) {
      return {
        level: 'high',
        action: '运行命令',
        target: cmd,
        impact: '该命令可能删除文件、改动远端仓库或系统配置',
        impactList: [...impactList, '命中破坏性模式（递归删除 / 强推 / 硬重置 / 发布等）'],
      };
    }
    return {
      level: 'mid',
      action: '运行命令',
      target: cmd,
      impact: '将在项目目录执行 shell 命令，可能改动文件与环境',
      impactList,
    };
  }

  // Host 观察层动作工具：外部副作用（别的应用的窗口/终端），按高风险走
  // 详情二次确认，目标描述即 Host 解析出的那句话。必须先于通用会议工具分类，
  // 否则会被 MEETING_TOOL_NAMES_SET 误判为"内置低风险"。
  const observedAction = OBSERVED_SESSION_ACTION_TOOLS[toolName];
  if (observedAction) {
    return {
      level: 'high',
      action: observedAction.action,
      target: observedSessionTarget(input),
      impact: observedAction.impact,
      impactList: observedAction.impactList,
    };
  }

  const meeting = classifyMeetingTool(toolName);
  if (meeting) return meeting;

  // 未知工具（MCP 等）：按高风险处理，要求详情确认
  return {
    level: 'high',
    action: `使用工具 ${toolName}`,
    target: '',
    impact: '未识别的工具调用，需查看完整参数后确认',
    impactList: [`工具：${toolName}`, '参数详见下方完整列表'],
  };
}

/** 会议 MCP 前缀 → 工具动作名；非会议工具返回 null。 */
function meetingActionName(toolName: string): string | null {
  for (const prefix of ['mcp__meeting__', 'mcp__meeting-worker__']) {
    if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
  }
  return null;
}

/** 应用自家的会议编排工具：只驱动 UI/编排状态，不该落到「未识别的工具调用」。
 *  派单/转向类会拉起 Worker 或改派任务 → 中风险；状态汇报/旁白类 → 低风险。 */
const MEETING_MID_TOOLS = new Set<string>([
  MEETING_TOOLS.DELEGATE, // delegate_task
  MEETING_TOOLS.DELEGATE_TO, // delegate_to
  MEETING_TOOLS.FOLLOW_UP_TASK, // follow_up_task
  MEETING_TOOLS.STEER_TASK, // steer_task
  MEETING_TOOLS.INTERRUPT_TASK, // interrupt_task
  MEETING_TOOLS.PLAN_MEETING, // plan_meeting
]);

function classifyMeetingTool(toolName: string): RiskAssessment | null {
  const action = meetingActionName(toolName);
  if (!action || !MEETING_TOOL_NAMES_SET.has(action)) return null;
  if (MEETING_MID_TOOLS.has(action)) {
    return {
      level: 'mid',
      action: `会议派单 ${action}`,
      target: String(toolName),
      impact: '将创建或调整后台 Worker 任务，Worker 自身的文件/命令请求仍会单独审批',
      impactList: [`工具：${toolName}`, '派单类操作，仅影响会议编排状态'],
    };
  }
  return {
    level: 'low',
    action: `会议状态同步 ${action}`,
    target: String(toolName),
    impact: '应用内置会议工具，只更新界面与任务状态，不触碰文件系统',
    impactList: [`工具：${toolName}`, '内置工具，无外部副作用'],
  };
}

export const RISK_LABELS: Record<RiskLevel, string> = {
  low: '低风险',
  mid: '中风险',
  high: '高风险',
  blocked: '需完整确认',
};

export const RISK_BADGE_CLASS: Record<RiskLevel, string> = {
  low: 'aha-risk-badge-low',
  mid: 'aha-risk-badge-mid',
  high: 'aha-risk-badge-high',
  blocked: 'aha-risk-badge-full',
};
