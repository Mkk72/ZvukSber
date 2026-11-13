/** Общие типы плеера. Чистый TypeScript: ни одного импорта Electron. */

export type PlaybackStatus = 'none' | 'paused' | 'playing';

/** Сырые данные, снятые со страницы сайта (mediaSession + элементы media). */
export interface RawMedia {
  tag: string;
  src: string;
  paused: boolean;
  currentTime: number;
  duration: number;
  readyState: number;
  volume: number;
}

export interface RawMetadata {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: string[];
}

export interface RawPositionState {
  position: number;
  duration: number;
  rate?: number;
  /** Момент, когда сайт сообщил позицию (ms, Date.now на странице). */
  at: number;
}

export interface RawControl {
  label: string;
  pressed?: string | null;
  tag?: string;
}

export interface RawSnapshot {
  handlers: string[];
  metadata: RawMetadata | null;
  mediaCount: number;
  media: RawMedia[];
  playbackState?: PlaybackStatus | null;
  positionState?: RawPositionState | null;
  controls?: RawControl[];
  errors?: string[];
}

export interface TrackInfo {
  title: string;
  artist: string;
  album: string;
  artwork: string | null;
}

export interface PlayerState {
  track: TrackInfo | null;
  status: PlaybackStatus;
  position: number;
  duration: number;
  /** 0..1, считается из position/duration. */
  progress: number;
  canPlay: boolean;
  canPause: boolean;
  canNext: boolean;
  canPrev: boolean;
  /** Есть ли валидный трек — от этого зависит, показывать ли плашку вообще. */
  hasTrack: boolean;
}

export const EMPTY_STATE: PlayerState = {
  track: null,
  status: 'none',
  position: 0,
  duration: 0,
  progress: 0,
  canPlay: false,
  canPause: false,
  canNext: false,
  canPrev: false,
  hasTrack: false
};
