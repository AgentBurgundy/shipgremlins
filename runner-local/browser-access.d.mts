export function browserOrigin(url: string): string;
export function prepareBrowserAccess(
  directory: string,
  input: { url?: string; credentials?: Record<string, string> },
): string[];
export interface BrowserPausedRequest {
  requestId: string;
  resourceType: string;
  frameId?: string;
  request: { url: string; method: string; headers: Record<string, string> };
}
export function installBrowserAccess(
  page: {
    context(): {
      newCDPSession(page: unknown): Promise<{
        on(
          name: string,
          handler: (event: BrowserPausedRequest) => Promise<void>,
        ): void;
        send(
          name: string,
          parameters?: Record<string, unknown>,
        ): Promise<unknown>;
        detach(): Promise<void>;
      }>;
    };
  },
  input: {
    url: string;
    bypass: string;
    restrictLogin?: boolean;
    onBlocked?: (
      destination: string,
      navigation: boolean,
      mainFrame: boolean,
    ) => void;
  },
): Promise<void>;
