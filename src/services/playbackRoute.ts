import type { PlaybackRoute } from '../types/hifi';
import { usePlaybackStore } from '../stores/usePlaybackStore';

// src/services/playbackRoute.ts
// 问“是不是原生引擎在发声”用 isNativeRoute / isNativeRouteNow（现在只有 HiFi）。
// 问“是不是 HiFi（mpv）这一条”用 isHifiPlaybackRoute：它自己比较，不调用 isNativeRoute。
// deckSrcForRoute：原生引擎发声时不给页面的 <audio> 装源。

export const isNativeRoute = (route: PlaybackRoute | null | undefined): boolean => route === 'hifi';

export const isHifiPlaybackRoute = (route: PlaybackRoute | null | undefined): boolean => route === 'hifi';

export const isNativeRouteNow = (): boolean => isNativeRoute(usePlaybackStore.getState().playbackRoute);

export const deckSrcForRoute = (
    route: PlaybackRoute | null | undefined,
    src: string | undefined,
): string | undefined => (isNativeRoute(route) ? undefined : src);

/** 按 PlaybackRoute 的每一个成员分发。加一条路线时这里和调用处的处理器都会报类型错误。 */
export const dispatchPlaybackRoute = <T>(
    route: PlaybackRoute,
    handlers: { [K in PlaybackRoute]: () => T },
): T => {
    switch (route) {
        case 'web': return handlers.web();
        case 'external': return handlers.external();
        case 'hifi': return handlers.hifi();
        default: {
            const unreachable: never = route;
            return unreachable;
        }
    }
};
