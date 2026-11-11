import { okBridgeReady } from '../../../services/ok/okAccess';
import { setLiveMode } from '../../../services/live/liveSession';
import { getWorkPlayback, setKaraoke } from '../../../services/multitrack/workPlayback';
import { defineCommand } from '../commandFactories';
import type { CommandPaletteCommand } from '../types';

// src/components/command-palette/commands/liveCommands.ts
// 五个直播命令。热键登记是后面的事，这里只接到桥。

const whenOk = (context: unknown) => !context || okBridgeReady();

export const liveCommands: CommandPaletteCommand[] = [
    defineCommand({
        id: 'live-mode-speech',
        group: 'playback',
        title: 'Live mode: speech',
        description: 'Switch the live plugin to plain speech',
        keywords: ['live mode', 'speech', '普通说话'],
        isAvailable: whenOk,
        execute: () => {
            void setLiveMode('speech', 'ui');
            return true;
        },
    }),
    defineCommand({
        id: 'live-mode-reverb-speech',
        group: 'playback',
        title: 'Live mode: reverb speech',
        description: 'Switch the live plugin to reverberated speech',
        keywords: ['live mode', 'reverb', '混响说话'],
        isAvailable: whenOk,
        execute: () => {
            void setLiveMode('reverb-speech', 'ui');
            return true;
        },
    }),
    defineCommand({
        id: 'live-mode-ai-follow',
        group: 'playback',
        title: 'Live mode: AI follow',
        description: 'Switch the live plugin to AI follow singing',
        keywords: ['live mode', 'follow', 'AI跟唱'],
        isAvailable: whenOk,
        execute: () => {
            void setLiveMode('ai-follow', 'ui');
            return true;
        },
    }),
    defineCommand({
        id: 'live-mode-ai-sing',
        group: 'playback',
        title: 'Live mode: AI sing',
        description: 'Switch the live plugin to AI singing',
        keywords: ['live mode', 'sing', 'AI唱歌'],
        isAvailable: whenOk,
        execute: () => {
            void setLiveMode('ai-sing', 'ui');
            return true;
        },
    }),
    defineCommand({
        id: 'live-karaoke-toggle',
        group: 'playback',
        title: 'Toggle a cappella',
        description: 'Silence or restore the instrumental while a work plays',
        keywords: ['a cappella', 'karaoke', '清唱'],
        isAvailable: whenOk,
        execute: () => {
            void setKaraoke(!getWorkPlayback().karaoke);
            return true;
        },
    }),
];
