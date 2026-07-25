/** How multi-agent messages are dispatched to the talker. */
export type DispatchMode = 'direct' | 'plan';

export const DISPATCH_MODE_LABELS: Record<DispatchMode, string> = {
  direct: '直接派活',
  plan: 'Plan 模式',
};

export const DISPATCH_MODE_HINTS: Record<DispatchMode, string> = {
  direct: '单任务立即 delegate_task，更快',
  plan: '先写详细计划再拆 worker DAG，需审批',
};

export function buildPlanDirective(userText: string): string {
  return `请把下面这段需求当作"多 Agent 并行 / Plan Mode"处理：先写出一份宿主能审阅的**详细计划**，再拆成可并行（或按依赖排序）的 worker 任务，**立即调用 plan_meeting**（不要先问我确认）。

计划必须包含：
1. goal — 成功标准（一段话）
2. approach — 做法、取舍、为何这样拆
3. steps — 有序步骤（每步 title + detail；能对应任务时填 taskId）
4. risks / openQuestions — 风险与未决问题（没有就空数组）
5. tasks — 每个 task：kebab-case id、短标题、给 worker 的完整 brief（目标/上下文/步骤/触及范围/验收），deps 标注依赖

不要只交一张空任务清单。任务 prompt 禁止一句话敷衍。

需求：
${userText}`;
}

export function buildDirectDirective(userText: string): string {
  return `请把下面这段需求当作"多 Agent 并行 / 直接派活"处理：**立即调用 delegate_task({description})**，不要调用 plan_meeting，不要先问我确认。派活后一句话告诉用户你让 worker 去做了。

需求：
${userText}`;
}

export function buildPlanAttachmentDirective(userText: string): string {
  if (userText.length > 0) {
    return `请阅读附带文档，并按"多 Agent 并行 / Plan Mode"写出详细计划（goal、approach、steps、risks、openQuestions）再拆 tasks，**调用 plan_meeting**。

需求：
${userText}`;
  }
  return '请阅读附带文档，按"多 Agent 并行 / Plan Mode"写出详细计划（goal、approach、steps、risks）并调用 plan_meeting。';
}

export function buildDirectAttachmentDirective(userText: string): string {
  if (userText.length > 0) {
    return `请阅读附带文档，并**立即 delegate_task** 处理，不要 plan_meeting。

需求：
${userText}`;
  }
  return '请阅读附带文档，并**立即 delegate_task** 处理，不要 plan_meeting。';
}
