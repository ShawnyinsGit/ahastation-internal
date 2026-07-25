/* Browser-only visual fixture for responsive/interaction regression.
 * Vite replaces import.meta.env.DEV with false in production builds, and the
 * bridge is installed only for an explicit ?ui-fixture=... URL. */
let startInstalledFixture: (() => void) | null = null;

if (import.meta.env.DEV) {
  const fixture = new URLSearchParams(window.location.search).get('ui-fixture');
  if (fixture) installFixture(fixture);
}

export function startDevFixtureIfPresent(): void {
  if (startInstalledFixture) {
    document.documentElement.dataset.fixtureStarted = 'true';
    startInstalledFixture();
  }
}

function installFixture(fixture: string): void {
  document.documentElement.dataset.uiFixture = fixture;
  const forceHandheld = new URLSearchParams(window.location.search).get('handheld') === '1';
  const sessionId = 'fixture-session';
  const now = Date.now();
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  let seeded = false;
  let restoreListed = false;
  const fixtureState = { emitted: 0, listeners: 0, restoreListed: false, seeded: false };
  (window as unknown as { __AHASTATION_FIXTURE_STATE__: typeof fixtureState })
    .__AHASTATION_FIXTURE_STATE__ = fixtureState;

  const backend = (
    id: string,
    displayName: string,
    iconId: string,
    version: string,
    isDefault = false,
  ) => ({
    id,
    displayName,
    iconId,
    available: true,
    binaryPath: `/usr/bin/${id}`,
    authMode: 'oauth',
    hasApiKey: false,
    hasAuthEntry: true,
    loggedIn: true,
    baseUrl: null,
    model: null,
    defaultModel: null,
    models: null,
    isDefault,
    installHint: null,
    supportsMcp: id === 'claude-code',
    supportsPermissions: true,
    supportsCoordinator: id === 'claude-code' || id === 'codex',
    supportsWorkers: true,
    workerImplementation: true,
    workerRuntimeState: 'available',
    workerRuntimeReason: '契约、版本与认证均已通过',
    version,
    expectedVersion: version,
    customAvatar: null,
    workerReleaseTier: id === 'claude-code' || id === 'codex' ? 'stable' as const : 'experimental' as const,
  });
  const backends = [
    backend('claude-code', 'Claude Code', 'claude', '2.1.150', true),
    backend('opencode', 'OpenCode', 'opencode', '1.18.3'),
    backend('codex', 'Codex', 'codex', '0.144.1'),
    backend('kimi', 'Kimi Code', 'kimi', '0.24.1'),
  ];
  const ok = async () => ({ ok: true });
  const noopSubscription = () => () => {};

  const emit = (event: Record<string, unknown>) => {
    fixtureState.emitted += 1;
    document.documentElement.dataset.fixtureEmitted = String(fixtureState.emitted);
    for (const listener of listeners) listener({ ...event, sessionId });
  };
  const workerEvent = (
    workerId: string,
    backendId: string,
    seq: number,
    payload: Record<string, unknown>,
  ) => emit({
    kind: 'worker-event',
    source: workerId,
    event: {
      schemaVersion: 2,
      eventId: crypto.randomUUID(),
      seq,
      timestamp: now + seq,
      meetingId: 'fixture-meeting',
      taskId: workerId,
      attempt: workerId === 'task-kimi' ? 2 : 1,
      workerId,
      backendId,
      payload,
    },
  });

  const seed = () => {
    if (seeded || fixture === 'lobby' || !restoreListed || listeners.size === 0) return;
    seeded = true;
    fixtureState.seeded = true;
    window.setTimeout(() => {
      const tasks = [
        ['task-open', 'OpenCode：统一事件管道', 'opencode', []],
        ['task-codex', 'Codex：生成 WorkReport', 'codex', []],
        ['task-kimi', 'Kimi：修复触屏交互', 'kimi', []],
        ['task-claude', 'Claude：复核交付证据', 'claude-code', []],
        ['task-release', '整合并生成 ARM64 发布包', 'codex', []],
      ] as const;
      if (fixture === 'recovery') {
        emit({
          kind: 'plan-updated',
          source: 'system',
          plan: {
            version: 1,
            nodes: [{
              id: 'task-recovered',
              title: '恢复中断的发布校验',
              executorBackendId: 'codex',
              deps: [],
              status: 'interrupted',
            }],
          },
        });
        return;
      }
      emit({
        kind: 'plan-updated',
        plan: {
          version: 1,
          nodes: tasks.map(([id, title, executorBackendId, deps], index) => ({
            id,
            title,
            executorBackendId,
            deps: [...deps],
            status: index < 4 ? 'running' : 'pending',
          })),
        },
      });
      for (const [id, title] of tasks.slice(0, 4)) {
        emit({
          kind: 'worker-spawned',
          workerId: id,
          source: id,
          hostId: 'default',
          title,
          deps: [],
          specialty: id === 'task-kimi' ? 'frontend' : 'backend',
        });
      }
      workerEvent('task-open', 'opencode', 1, { kind: 'progress', message: '正在归一化 SSE 事件', percent: 64 });
      workerEvent('task-open', 'opencode', 2, { kind: 'tool', toolName: 'edit', phase: 'started', detail: 'electron/backends/opencode-adapter.ts' });
      workerEvent('task-codex', 'codex', 1, { kind: 'progress', message: '正在合成标准 WorkReport', percent: 51 });
      workerEvent('task-codex', 'codex', 2, { kind: 'tool', toolName: 'shell', phase: 'started', detail: 'npm test' });
      workerEvent('task-kimi', 'kimi', 1, { kind: 'progress', message: '正在验证 1024px 触屏抽屉', percent: 72 });
      workerEvent('task-claude', 'claude-code', 1, { kind: 'progress', message: '正在复核测试与文件证据', percent: 42 });
      emit({
        kind: 'permission-request',
        source: 'task-kimi',
        hostId: 'default',
        id: 'fixture-permission',
        toolName: 'write_file',
        input: { path: 'src/styles.css' },
        toolUseID: 'fixture-tool',
      });
      emit({
        kind: 'coordinator-briefing',
        source: 'talker',
        briefing: {
          id: 'capacity-fixture',
          timestamp: now,
          kind: 'capacity',
          title: 'Worker 容量已满',
          summary: '四个 Worker 正在执行，新任务保持排队。',
          completedTasks: 0,
          failedTasks: 0,
          files: 3,
          testsPassed: 18,
          testsFailed: 0,
          blockers: [],
          recommendedAction: 'continue',
          capacity: { running: 4, limit: 4, waiting: 1 },
        },
      });

      if (fixture === 'plan') {
        emit({
          kind: 'plan-proposed',
          source: 'talker',
          tasks: tasks.slice(0, 3).map(([id, title, executorBackendId], index) => ({
            id,
            title,
            prompt: `${title}，保留统一协议与 journal-first 约束。`,
            deps: index === 2 ? ['task-open'] : [],
            executorBackendId,
            requiresDecision: index === 2,
            acceptanceCriteria: [{
              id: `${id}-acceptance`,
              description: '契约测试与类型检查通过',
              verification: { kind: 'command', argv: ['npm', 'test'] },
            }],
          })),
        });
      }

      if (fixture === 'delivery') {
        const report = {
          status: 'completed',
          summary: '统一事件、WorkReport 与交付校验已接通。',
          files: [
            { path: 'electron/worker-protocol.ts', action: 'created' },
            { path: 'src/components/DeliveryViewer.tsx', action: 'modified' },
          ],
          tests: [
            { command: 'npm test', status: 'passed', summary: '304 tests passed' },
            { command: 'npm run build', status: 'passed', summary: 'renderer + electron' },
          ],
          unresolved: [{ code: 'BOARD_GATE', message: '等待 RK3588 真机 soak', blocking: false }],
        };
        workerEvent('task-open', 'opencode', 3, { kind: 'tool', toolName: 'edit', phase: 'completed' });
        workerEvent('task-open', 'opencode', 4, { kind: 'delivery', report });
        emit({
          kind: 'worker-delivery',
          source: 'task-open',
          workerId: 'task-open',
          taskId: 'task-open',
          deliveryId: 'delivery-fixture',
          title: 'OpenCode：统一事件管道',
          summary: report.summary,
          files: [
            {
              path: '/workspace/ahastation-demo/electron/worker-protocol.ts',
              snapshotRelativePath: 'electron/worker-protocol.ts',
              sizeBytes: 8192,
              sha256: '4f3d7a90656ddf35a6fb9455f671acde5c260e59d26ce1af5ec4973c4e59f500',
              previewStatus: 'copied',
            },
          ],
        });
        emit({
          kind: 'delivery-status',
          source: 'task-open',
          workerId: 'task-open',
          taskId: 'task-open',
          delivery: {
            id: 'delivery-fixture',
            meetingId: 'fixture-meeting',
            status: 'awaiting-delivery-acceptance',
            spec: {
              version: 1,
              objective: '接通统一事件与交付闭环',
              acceptanceCriteria: [{
                id: 'contract-tests',
                description: '契约测试通过',
                verification: { kind: 'command', argv: ['npm', 'test'] },
              }],
            },
            sourceRevision: 'fixture',
            workspace: '/workspace/ahastation-demo',
            attempt: 1,
            attempts: [{
              attempt: 1,
              report,
              verification: { passed: true, checks: [{ description: 'npm test', passed: true, durationMs: 5020 }] },
              review: { passed: true, findings: [] },
              outcome: 'awaiting-acceptance',
              updatedAt: now,
            }],
            candidate: {
              id: 'candidate-fixture',
              attempt: 1,
              report,
              verification: { passed: true, checks: [{ description: 'npm test', passed: true, durationMs: 5020 }] },
              review: { passed: true, findings: [] },
            },
            updatedAt: now,
          },
        });
        emit({
          kind: 'plan-updated',
          source: 'talker',
          plan: {
            version: 2,
            nodes: tasks.map(([id, title, executorBackendId, deps]) => ({
              id,
              title,
              executorBackendId,
              deps: [...deps],
              status: id === 'task-open'
                ? 'awaiting-acceptance'
                : id === 'task-release'
                  ? 'pending'
                  : 'running',
            })),
          },
        });
      }
    }, 250);
  };
  startInstalledFixture = seed;

  const bridge = {
    platform: 'linux',
    backendAuth: {
      list: async () => backends,
      setDefault: ok,
      setApiKey: ok,
      setBaseUrl: ok,
      setModel: ok,
      setMode: ok,
      setAvatar: ok,
      checkStatus: async () => ({ ok: true, loggedIn: true }),
      loginOAuth: ok,
      install: ok,
      onInstallProgress: noopSubscription,
    },
    sessions: {
      listRecoverable: async () => ({ ok: true, meetings: [] }),
      listRestore: async () => {
        restoreListed = true;
        fixtureState.restoreListed = true;
        return {
          ok: true,
          openTabs: [],
          recentCwds: [{ path: '/workspace/ahastation-demo', lastOpenedAt: now }],
          lastActiveCwd: null,
        };
      },
      open: async () => fixture === 'lobby'
        ? ({ ok: false, error: 'visual fixture is read-only' })
        : ({
            ok: true,
            sessionId,
            cwd: '/workspace/ahastation-demo',
            backendId: 'claude-code',
          }),
      setActive: ok,
      close: ok,
      listHosts: async () => ({ ok: true, hosts: [{ id: 'default', backendId: 'claude-code', role: 'coordinator' }] }),
      onTabsChanged: noopSubscription,
    },
    skills: { list: async () => ({ ok: true, skills: [] }) },
    transcripts: {
      load: async () => ({ ok: true, entries: [] }),
      append: ok,
      clear: ok,
    },
    documents: {
      read: async () => ({ ok: false, error: '预览在视觉测试夹具中不可用' }),
      list: async () => ({ ok: true, entries: [] }),
      openExternal: ok,
    },
    tasks: {
      getSnapshot: async (_targetSessionId: string, taskId: string) => ({
        ok: true,
        value: {
          schemaVersion: 1,
          sessionId,
          meetingId: 'fixture-meeting',
          task: {
            id: taskId,
            title: {
              'task-open': 'OpenCode：统一事件管道',
              'task-codex': 'Codex：生成 WorkReport',
              'task-kimi': 'Kimi：修复触屏交互',
              'task-claude': 'Claude：复核交付证据',
              'task-release': '整合并生成 ARM64 发布包',
            }[taskId] ?? taskId,
            prompt: '在独立工作区完成任务，提交结构化证据，由 Coordinator 复核并自动集成。',
            deps: taskId === 'task-release' ? ['task-open', 'task-codex', 'task-kimi', 'task-claude'] : [],
            status: taskId === 'task-release' ? 'pending' : 'running',
            backendId: taskId.includes('kimi')
              ? 'kimi'
              : taskId.includes('open')
                ? 'opencode'
                : taskId.includes('claude')
                  ? 'claude-code'
                  : 'codex',
            attempt: taskId === 'task-kimi' ? 2 : 1,
            requestedProfile: {
              schemaVersion: 1,
              backendId: taskId.includes('open') ? 'opencode' : 'codex',
              workMode: 'balanced',
              contextMode: 'meeting-summary',
              timeoutMs: 1_800_000,
              maxTokenBudget: 200_000,
            },
            effectiveProfile: {
              schemaVersion: 1,
              backendId: taskId.includes('open') ? 'opencode' : 'codex',
              workMode: 'balanced',
              contextMode: 'meeting-summary',
              timeoutMs: 1_800_000,
              maxTokenBudget: 200_000,
              runtimeVersion: 'fixture',
              capabilityHash: 'fixture-capability',
              diagnostics: [],
            },
            context: {
              mode: 'meeting-summary',
              messageCount: 12,
              decisionCount: 3,
              dependencyReportCount: taskId === 'task-release' ? 4 : 0,
              attachmentCount: 1,
              byteLength: 4_820,
              packageHash: '8c11a8e76ce8a49c',
            },
            authority: {
              allowedToolKinds: ['read', 'write', 'execute'],
              writePathCount: 2,
              commandCount: 3,
              networkHostCount: 0,
              hasEnvironmentAccess: false,
            },
            workspace: {
              kind: 'git-worktree',
              branch: `task/${taskId}`,
              sourceRevision: 'fixture-base',
              managed: true,
            },
            acceptanceCriteria: [
              { description: '类型检查通过' },
              { description: '相关回归测试通过' },
            ],
          },
          mailbox: [{
            schemaVersion: 1,
            id: `fixture-message-${taskId}`,
            seq: 1,
            taskId,
            attempt: taskId === 'task-kimi' ? 2 : 1,
            sender: 'coordinator',
            kind: 'instruction',
            payload: { text: '按冻结计划执行，并在完成时提交 WorkReport。' },
            status: 'acknowledged',
            timestamp: now,
          }],
          mailboxTruncated: false,
          attempts: [{
            attempt: taskId === 'task-kimi' ? 2 : 1,
            backendId: taskId.includes('open') ? 'opencode' : 'codex',
            status: 'running',
            startedAt: now - 48_000,
            durationMs: 48_000,
            tokenCost: 4_200,
            report: {
              status: 'partial',
              summary: '核心修改已完成，正在补充验证。',
              files: [
                { path: 'src/components/TaskInspector.tsx', action: 'modified' },
                { path: 'src/styles.css', action: 'modified' },
              ],
              tests: [{ command: 'npm run typecheck:renderer', status: 'passed' }],
              unresolved: [],
            },
            verification: { status: 'passed' },
            reviewCoverage: { reviewedChunks: 7, totalChunks: 9, complete: false },
            candidateCommit: '514ee30a144ce8a4',
          }],
          ...(taskId === 'task-claude'
            ? {
                reviewEvidence: {
                  reviewId: 'fixture-review',
                  status: 'active',
                  pending: [{
                    chunkId: 'fixture-binary-chunk',
                    chunkHash: 'a'.repeat(64),
                    path: 'release/AhaMeet-arm64.dmg',
                    kind: 'binary',
                    byteLength: 128_000,
                    lineCount: 0,
                  }],
                },
              }
            : {}),
          diagnostics: [],
          lastSeq: 0,
        },
      }),
      getEvents: async (_targetSessionId: string, _taskId: string, afterSeq: number) => ({
        ok: true,
        value: { events: [], nextAfterSeq: afterSeq, hasMore: false },
      }),
      onEvent: noopSubscription,
      followUp: ok,
      steer: async () => ({ ok: true, queued: true }),
      interrupt: ok,
      extendBudget: async (
        _sessionId: string,
        _taskId: string,
        expectedPlanVersion: number,
        budget: {
          schemaVersion: 1;
          maxAttempts: number;
          maxTotalTokens: number;
          maxTotalDurationMs: number;
          maxStagnantAttempts: number;
        },
      ) => ({
        ok: true,
        planVersion: expectedPlanVersion + 1,
        budget,
      }),
      confirmReviewEvidence: ok,
      resumeReview: ok,
    },
    auth: {
      loginSubscription: ok,
      checkSubscriptionStatus: async () => ({ loggedIn: true }),
    },
    companion: { toggle: ok, ttsState: () => {} },
    browser: {
      onStateUpdate: noopSubscription,
      getState: async () => ({ tabs: [], activeTabId: null, visible: false }),
      openTab: async () => ({ ok: false, error: 'visual fixture is read-only' }),
      closeTab: ok,
      setActive: ok,
      navigate: ok,
      back: ok,
      forward: ok,
      reload: ok,
      setBounds: ok,
      setVisible: ok,
    },
    openCodeEditor: {
      list: async () => ({ ok: true, windows: [] }),
      open: ok,
      close: ok,
    },
    getVoiceConfig: async () => ({ enabled: false, voicePrint: null }),
    getVoicePref: async () => ({
      selectedVoiceName: null,
      guidanceDismissed: true,
      speechFilterMode: 'strict',
      voicePolishEnabled: false,
      reportModeEnabled: false,
      handheldMode: forceHandheld ? 'handheld' : 'auto',
    }),
    setVoicePref: ok,
    onEvent: (listener: (event: Record<string, unknown>) => void) => {
      listeners.add(listener);
      fixtureState.listeners = listeners.size;
      return () => {
        listeners.delete(listener);
        fixtureState.listeners = listeners.size;
      };
    },
    onUpdateAvailable: noopSubscription,
    onDisplayChanged: noopSubscription,
    deviceDiagnostics: async () => ({
      ok: true,
      diagnostics: {
        platform: 'linux',
        arch: 'arm64',
        kernel: '5.10.160',
        totalMemoryBytes: 16 * 1024 ** 3,
        electronVersion: '42.0.0',
        sessionType: 'x11',
        gpu: { available: true, status: {} },
        audio: { microphone: 'available', speaker: 'available', xfyun: true },
        workspace: { git: true, worktree: true, version: '2.48.1' },
        capacity: { hosts: 3, workers: 4 },
      },
    }),
  };
  window.vibeMeet = new Proxy(bridge as never, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      return ok;
    },
  });
}
