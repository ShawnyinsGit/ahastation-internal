/**
 * Explains why a delivery is parked on host Accept instead of auto-integrating
 * after Coordinator review. Freeze-success code paths never reach this state.
 */

export interface HostAcceptanceInput {
  status: string;
  error?: string;
  files?: readonly unknown[];
  report?: { files?: readonly unknown[]; status?: string };
  view?: {
    candidate?: { reportOnly?: boolean; freezeDeferred?: boolean };
  };
}

export function isFreezeDeferredPark(delivery: HostAcceptanceInput): boolean {
  if (delivery.view?.candidate?.freezeDeferred === true) return true;
  return /freeze|冻结/i.test(delivery.error?.trim() ?? '');
}

export function isTrueReportOnlyPark(delivery: HostAcceptanceInput): boolean {
  if (isFreezeDeferredPark(delivery)) return false;
  if (delivery.view?.candidate?.reportOnly === true) return true;
  return (delivery.report?.files?.length ?? delivery.files?.length ?? 0) === 0;
}

/** Freeze-deferred writers cannot Accept into Meeting-branch acceptance. */
export function canHostAcceptDelivery(delivery: HostAcceptanceInput): boolean {
  if (delivery.status === 'reworking') {
    return (delivery.report?.files?.length ?? delivery.files?.length ?? 0) === 0;
  }
  if (delivery.status !== 'awaiting-delivery-acceptance') return false;
  return !isFreezeDeferredPark(delivery);
}

export function hostAcceptanceReason(delivery: HostAcceptanceInput): string | null {
  if (delivery.status !== 'awaiting-delivery-acceptance') return null;

  const error = delivery.error?.trim() ?? '';

  if (isFreezeDeferredPark(delivery)) {
    return [
      '候选冻结未成功，无法进入 Meeting 集成分支。',
      '按 ADR，有文件变更的交付不能靠点确认伪造成「已接受」——下游依赖也不会放行。',
      error ? `原因：${error}` : null,
      '请点「还要继续改」让 Worker 返工并重新冻结；不要用确认跳过集成。',
    ].filter(Boolean).join(' ');
  }

  if (isTrueReportOnlyPark(delivery)) {
    return [
      '这一轮是纯报告交付（无可冻结的代码变更）。',
      '冻结成功的代码交付会在 Coordinator 审查后自动集成；纯报告需要你确认后才算完成。',
      error ? `详情：${error}` : null,
    ].filter(Boolean).join(' ');
  }

  if (error) {
    return `需要你确认后才能继续：${error} 冻结成功时通常会自动集成，不必点验收。`;
  }

  return '需要你确认这份交付。冻结成功的代码交付通常在 Coordinator 审查后自动集成，无需点验收。';
}

export function hostAcceptancePrimaryLabel(delivery: HostAcceptanceInput): string {
  if (delivery.status === 'reworking') return '接受当前报告';
  if (isFreezeDeferredPark(delivery)) return '无法确认 · 请返工';
  if (isTrueReportOnlyPark(delivery)) return '确认报告';
  return '通过 · 确认';
}
