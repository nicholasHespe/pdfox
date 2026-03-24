// Type declaration for window.api exposed by preload.ts via contextBridge

interface Window {
  api: {
    openFileDialog: () => Promise<{ filePath: string; buffer: ArrayBuffer }[] | null>;
    saveFile: (filePath: string, arrayBuffer: ArrayBuffer) => Promise<{ ok: boolean; error?: string }>;
    saveFileCopy: (arrayBuffer: ArrayBuffer, defaultPath?: string) => Promise<{ ok: boolean; filePath?: string }>;
    showMessageBox: (options: { type?: string; buttons: string[]; title?: string; message: string; detail?: string; defaultId?: number; cancelId?: number }) => Promise<number>;
    openNewWindow: (filePath?: string) => Promise<{ ok: boolean }>;
    getWindowId: () => Promise<number>;
    openFileFromPath: (filePath: string) => Promise<{ filePath: string; buffer: ArrayBuffer } | null>;
    notifyTabTransferred: (sourceWindowId: number, filePath: string) => Promise<{ ok: boolean }>;
    getExtensionId: () => Promise<{ ok: boolean; id?: string; error?: string }>;
    setExtensionId: (id: string) => Promise<{ ok: boolean; error?: string }>;
    onMenuEvent: (callback: (event: string) => void) => void;
    onOpenFileData: (callback: (data: { filePath: string; buffer: ArrayBuffer }) => void) => void;
    onCloseTabByFilepath: (callback: (filePath: string) => void) => void;
    copyFileToClipboard: (filePath: string) => Promise<{ ok: boolean }>;
    revealInExplorer:    (filePath: string) => Promise<{ ok: boolean }>;
    startDrag: (filePath: string) => void;
    setUiZoom: (factor: number) => void;
    getUiZoom: () => number;
    minimizeWindow: () => Promise<{ ok: boolean }>;
    toggleMaximize: () => Promise<{ ok: boolean }>;
    closeWindow: () => Promise<{ ok: boolean }>;
    platform: string;
    openDevTools: () => void;
    focusWindow: () => Promise<{ ok: boolean }>;
    forceClose: () => Promise<{ ok: boolean }>;
    onBeforeClose: (callback: () => void) => void;
  };
}
