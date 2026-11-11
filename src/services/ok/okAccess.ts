import { OK_CONTRACT_VERSION } from '../../types/multitrack';
import type { OkBridge } from '../../types/okBridge';

// src/services/ok/okAccess.ts
// 渲染端读 window.electron.ok 的唯一入口。版本对不上就当没有，避免按错契约画界面。

let loggedMismatch = false;

/** 契约版本一致时返回桥，否则 null。网页版和没开 mock 的开发构建都是 null。 */
export function readOkBridge(): OkBridge | null {
    if (typeof window === 'undefined') return null;
    const ok = window.electron?.ok;
    if (!ok) return null;
    if (ok.contractVersion !== OK_CONTRACT_VERSION) {
        if (!loggedMismatch) {
            loggedMismatch = true;
            console.warn('[ok] contract version mismatch, ok UI stays off', ok.contractVersion, OK_CONTRACT_VERSION);
        }
        return null;
    }
    return ok;
}

export function okBridgeReady(): boolean {
    return readOkBridge() !== null;
}
