import {
  PANEL_POLICY_MODES,
  type PolicyMode,
} from '../shared/policy-contract';

export interface StudioControlsSnapshot {
  workspaceRoot: string | null;
  policyMode: PolicyMode;
  loading: boolean;
  error: string | null;
}

export interface StudioControlsHost {
  call(
    invocationName: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

export interface StudioControlsStore {
  getSnapshot(): Readonly<StudioControlsSnapshot>;
  subscribe(listener: (snapshot: Readonly<StudioControlsSnapshot>) => void): () => void;
  refresh(): Promise<void>;
  setWorkspace(root: string): Promise<boolean>;
  setPolicy(mode: PolicyMode): Promise<boolean>;
  destroy(): void;
}

const DEFAULT_SNAPSHOT: StudioControlsSnapshot = {
  workspaceRoot: null,
  policyMode: 'auto',
  loading: false,
  error: null,
};

function isPolicyMode(value: unknown): value is PolicyMode {
  return typeof value === 'string'
    && (PANEL_POLICY_MODES as readonly string[]).includes(value);
}

export function createStudioControlsStore(host: StudioControlsHost): StudioControlsStore {
  let snapshot: StudioControlsSnapshot = { ...DEFAULT_SNAPSHOT };
  let destroyed = false;
  const listeners = new Set<(snapshot: Readonly<StudioControlsSnapshot>) => void>();

  function publish(patch: Partial<StudioControlsSnapshot>): void {
    if (destroyed) return;
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A presentation subscriber must not break state propagation.
      }
    }
  }

  async function refresh(): Promise<void> {
    if (destroyed) return;
    publish({ loading: true, error: null });
    const result = await host.call('settings.get', {});
    if (destroyed) return;
    if (!result.ok) {
      publish({ loading: false, error: result.error ?? 'settings-get-failed' });
      return;
    }
    const data = (result.data ?? {}) as {
      workspaceRoot?: unknown;
      policyMode?: unknown;
    };
    publish({
      loading: false,
      error: null,
      workspaceRoot: typeof data.workspaceRoot === 'string' && data.workspaceRoot
        ? data.workspaceRoot
        : null,
      policyMode: isPolicyMode(data.policyMode) ? data.policyMode : snapshot.policyMode,
    });
  }

  async function setWorkspace(root: string): Promise<boolean> {
    if (destroyed) return false;
    publish({ loading: true, error: null });
    const result = await host.call('workspace.set', { root });
    if (destroyed) return false;
    if (!result.ok) {
      publish({ loading: false, error: result.error ?? 'workspace-set-failed' });
      return false;
    }
    const saved = (result.data as { root?: unknown } | undefined)?.root;
    if (typeof saved === 'string' && saved) {
      publish({ workspaceRoot: saved });
    }
    await refresh();
    return true;
  }

  async function setPolicy(mode: PolicyMode): Promise<boolean> {
    if (destroyed) return false;
    publish({ loading: true, error: null });
    const result = await host.call('policy.set', { mode });
    if (destroyed) return false;
    if (!result.ok) {
      publish({ loading: false, error: result.error ?? 'policy-set-failed' });
      return false;
    }
    const saved = (result.data as { mode?: unknown } | undefined)?.mode;
    if (isPolicyMode(saved)) {
      publish({ policyMode: saved });
    }
    await refresh();
    return true;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (destroyed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    setWorkspace,
    setPolicy,
    destroy() {
      destroyed = true;
      listeners.clear();
    },
  };
}
