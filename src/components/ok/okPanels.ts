// src/components/ok/okPanels.ts
// ok唱歌 各块界面开哪一块。命令和按钮都改这里，OkHost 只订阅。

export type OkPanelId = 'stems' | 'works' | 'cover' | null;

const listeners = new Set<() => void>();
let panel: OkPanelId = null;

export function getOkPanel(): OkPanelId {
    return panel;
}

export function subscribeOkPanel(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function setOkPanel(next: OkPanelId): void {
    if (panel === next) return;
    panel = next;
    listeners.forEach(listener => listener());
}

export function toggleOkPanel(next: Exclude<OkPanelId, null>): void {
    setOkPanel(panel === next ? null : next);
}
