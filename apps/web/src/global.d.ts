export {};

declare global {
  interface Window {
    daming?: {
      readonly shell?: string;
      readonly version?: string;
      chooseDirectory?: (options?: { create?: boolean }) => Promise<string | null>;
      getCloseBehavior?: () => Promise<{ behavior: 'tray' | 'quit' }>;
      setCloseBehavior?: (behavior: 'tray' | 'quit') => Promise<{ ok: boolean; behavior: 'tray' | 'quit' }>;
      onMenu?: (callback: (payload: { action: string; page?: string }) => void) => () => void;
    };
  }
}
