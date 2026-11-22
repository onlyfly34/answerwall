/**
 * The part of the extension API this extension calls, and nothing more: the
 * list doubles as an inventory of what the extension can do. Replaced at
 * build time: the version of the workspace, and whether this is the test
 * build that carries the stand-in site.
 */
declare const __APP_VERSION__: string;
declare const __TEST_SITE__: boolean;

declare namespace chrome {
  interface ChromeEvent<Listener> {
    addListener(listener: Listener): void;
    removeListener(listener: Listener): void;
  }

  namespace runtime {
    const id: string;
    interface MessageSender {
      tab?: { id?: number };
      frameId?: number;
    }
    interface Port {
      name: string;
      sender?: MessageSender;
      postMessage(message: unknown): void;
      disconnect(): void;
      onMessage: ChromeEvent<(message: unknown) => void>;
      onDisconnect: ChromeEvent<() => void>;
    }
    interface ExtensionContext {
      tabId: number;
      documentUrl?: string;
    }
    function connect(info: { name: string }): Port;
    function getURL(path: string): string;
    function getContexts(filter: {
      contextTypes?: 'TAB'[];
      tabIds?: number[];
    }): Promise<ExtensionContext[]>;
    const onConnect: ChromeEvent<(port: Port) => void>;
    const onStartup: ChromeEvent<() => void>;
    const onInstalled: ChromeEvent<() => void>;
  }

  namespace storage {
    interface StorageArea {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      setAccessLevel(options: {
        accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS';
      }): Promise<void>;
    }
    const local: StorageArea;
  }

  namespace permissions {
    function contains(permissions: { origins: string[] }): Promise<boolean>;
    function request(permissions: { origins: string[] }): Promise<boolean>;
  }

  namespace tabs {
    interface Tab {
      id?: number;
    }
    function getCurrent(): Promise<Tab | undefined>;
    function create(properties: { url: string }): Promise<Tab>;
    function update(tabId: number, properties: { active: boolean }): Promise<Tab | undefined>;
    const onRemoved: ChromeEvent<(tabId: number) => void>;
    const onUpdated: ChromeEvent<(tabId: number, changeInfo: { status?: string }) => void>;
  }

  namespace action {
    const onClicked: ChromeEvent<() => void>;
  }

  namespace declarativeNetRequest {
    interface Rule {
      id: number;
      priority: number;
      action: {
        type: 'modifyHeaders';
        responseHeaders: { header: string; operation: 'remove' }[];
      };
      condition: {
        tabIds: number[];
        initiatorDomains: string[];
        requestDomains: string[];
        resourceTypes: 'sub_frame'[];
      };
    }
    function updateSessionRules(options: {
      removeRuleIds?: number[];
      addRules?: Rule[];
    }): Promise<void>;
    function getSessionRules(): Promise<Rule[]>;
  }
}
