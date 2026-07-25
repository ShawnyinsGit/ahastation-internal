export type AsrMode = 'xfyun' | 'probing' | 'unavailable';

export type MicrophoneCaptureStatus =
  | 'idle'
  | 'requesting-permission'
  | 'initializing'
  | 'ready'
  | 'permission-denied'
  | 'failed'
  | 'unavailable';

interface MicrophoneUiStateOptions {
  mode: AsrMode;
  captureStatus: MicrophoneCaptureStatus;
}

export function deriveMicrophoneUiState({
  mode,
  captureStatus,
}: MicrophoneUiStateOptions): { supported: boolean; retryable: boolean } {
  if (mode === 'probing') return { supported: true, retryable: false };
  if (mode === 'unavailable') return { supported: false, retryable: false };
  return {
    supported: true,
    retryable: captureStatus === 'permission-denied' || captureStatus === 'failed',
  };
}

export function computeAudioLevel(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let energy = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    energy += normalized * normalized;
  }
  return Math.min(1, Math.sqrt(energy / samples.length));
}

export function serializeMicrophoneOperation(
  previous: Promise<void>,
  operation: () => Promise<void>,
): Promise<void> {
  return previous.catch(() => {}).then(operation);
}
