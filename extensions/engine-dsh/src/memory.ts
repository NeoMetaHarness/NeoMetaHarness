/** Session-scoped Neo memory credentials, provided by the Gateway vault bridge. */
export interface DshMemoryBridge {
  binding(sessionId: string, workspaceId: string): Promise<{
    endpoint: string; token: string; profile: string;
  } | undefined>;
  forget(sessionId: string): void;
}
