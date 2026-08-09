interface ElectronAPI {
  invoke(channel: string, args?: Record<string, unknown>): Promise<unknown>;
}

interface Window {
  electronAPI: ElectronAPI;
}
