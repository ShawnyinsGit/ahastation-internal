/* --------------------------------------------------------------------------
 * 统一批准模型 · 风险分级（04 BR-A1 / 03 §4.1）
 * 低=单击 · 中=按住 800ms · 高=详情二次确认 · 禁止快捷=仅完整流程。
 * 现有后端只上报 toolName + input，分级在前端按工具与参数启发式判定；
 * 后端的 auto-approve 三档（off/read/all）照旧生效，与本模型互补。
 * ------------------------------------------------------------------------ */

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

  // 未知工具（MCP 等）：按高风险处理，要求详情确认
  return {
    level: 'high',
    action: `使用工具 ${toolName}`,
    target: '',
    impact: '未识别的工具调用，需查看完整参数后确认',
    impactList: [`工具：${toolName}`, '参数详见下方完整列表'],
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
