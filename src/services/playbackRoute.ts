import type { PlaybackRoute } from '../types/hifi';

// src/services/playbackRoute.ts
// isNativeRoute：这条路线是不是由应用自己的原生引擎发声（现在只有 HiFi）。
// isHifiPlaybackRoute：就是 HiFi 这一条。它自己比较，不调用 isNativeRoute，以后的原生路线不会被算成 HiFi。

export const isNativeRoute = (route: PlaybackRoute): boolean => route === 'hifi';

export const isHifiPlaybackRoute = (route: PlaybackRoute): boolean => route === 'hifi';
