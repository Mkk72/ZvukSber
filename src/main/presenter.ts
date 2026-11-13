import { canRun, type PlayerCommand } from '../core/commands';
import { nowPlayingText } from '../core/format';
import { toBarViewModel, type BarViewModel } from '../core/barViewModel';
import { stateFromSnapshot } from '../core/playerState';
import { buildTrayMenu, type MenuItemModel } from '../core/trayMenuModel';
import { EMPTY_STATE, type PlayerState } from '../core/types';
import type { SiteBridge } from './bridge';

export type BarLayout = 'bar' | 'wide';

/** Что презентер хочет от мини-плеера. Реализация — в main, с Electron. */
export interface IBarView {
  setState(view: BarViewModel): void;
}

/** Что презентер хочет от трея. */
export interface ITrayView {
  setMenu(items: MenuItemModel[]): void;
  setTooltip(text: string): void;
}

/** Возможности оболочки, которые презентер не должен знать по классам. */
export interface IShellActions {
  windowVisible(): boolean;
  layout(): BarLayout;
  alwaysOnTop(): boolean;
  autostart(): boolean;
  toggleWindow(): void;
  setLayout(layout: BarLayout): void;
  setAlwaysOnTop(value: boolean): void;
  setAutostart(value: boolean): void;
  /** Перейти на главную сайта и дождаться загрузки. */
  goHome(): Promise<void>;
  quit(): void;
}

function signature(state: PlayerState): string {
  return [
    state.track?.title ?? '',
    state.track?.artist ?? '',
    state.status,
    state.canNext,
    state.canPrev,
    state.hasTrack,
    Math.round(state.duration)
  ].join('|');
}

/**
 * Презентер: опрашивает мост, превращает снимок в состояние, раздаёт его видам
 * и исполняет команды. Ни одного импорта Electron — тестируется с фейковыми видами.
 */
export class PlayerPresenter {
  private state: PlayerState = EMPTY_STATE;
  private timer: NodeJS.Timeout | null = null;
  private lastSignature = '';
  private lastMenuSignature = '';

  constructor(
    private readonly bridge: SiteBridge,
    private readonly bar: IBarView,
    private readonly tray: ITrayView,
    private readonly shell: IShellActions,
    private readonly pollMs = 500
  ) {}

  getState(): PlayerState {
    return this.state;
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Один цикл опроса. Публичный, чтобы можно было дёрнуть из теста/диагностики. */
  async poll(): Promise<PlayerState> {
    const raw = await this.bridge.snapshot();
    const next = stateFromSnapshot(raw);
    const sig = signature(next);
    if (sig !== this.lastSignature) {
      this.lastSignature = sig;
      this.state = next;
      this.bar.setState(toBarViewModel(next));
      this.tray.setTooltip(nowPlayingText(next.track?.title ?? '', next.track?.artist ?? ''));
      this.renderTrayMenu();
    } else {
      this.state = next;
    }
    return next;
  }

  /** Пункты меню в текущем состоянии — их используют и трей, и кнопка меню на плашке. */
  menuItems(): MenuItemModel[] {
    return buildTrayMenu(this.state, {
      windowVisible: this.shell.windowVisible(),
      alwaysOnTop: this.shell.alwaysOnTop(),
      layout: this.shell.layout(),
      autostart: this.shell.autostart()
    });
  }

  renderTrayMenu(force = false): void {
    const items = this.menuItems();
    const sig = items.map((i) => `${i.id}:${i.label}:${i.enabled ? 1 : 0}:${i.checked ? 1 : 0}`).join('|') + this.shell.layout();
    if (!force && sig === this.lastMenuSignature) return;
    this.lastMenuSignature = sig;
    this.tray.setMenu(items);
  }

  /** Клик по кнопке сайта с одной повторной попыткой: плашка может ещё не смонтироваться. */
  private async clickWithRetry(action: 'next' | 'prev' | 'like' | 'dislike' | 'shuffle' | 'repeat' | 'queue'): Promise<void> {
    const first = await this.bridge.click(action);
    if (first.clicked) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
    await this.bridge.click(action);
  }

  /** Потоки: «Мой поток» по умолчанию, дальше настроения и жанры с главной сайта. */
  private flows: string[] = ['Мой поток', 'Утро', 'Спорт', 'Медитация', 'Поп', 'Хип-хоп', 'Рок', 'Веселое', 'Легкая'];

  async refreshFlows(): Promise<string[]> {
    const discovered = await this.bridge.listFlows();
    if (discovered.length > 0) this.flows = discovered;
    return this.flows;
  }

  flowMenuItems(): MenuItemModel[] {
    const items: MenuItemModel[] = this.flows.map((title) => ({
      id: 'flow:' + title,
      label: title,
      enabled: true,
      type: 'normal'
    }));
    items.push({ id: 'sep-flows', label: '', enabled: false, type: 'separator' });
    items.push({ id: 'menu-back', label: '← Назад', enabled: true, type: 'normal' });
    return items;
  }

  /** Запустить поток: главная → карточка потока → «Запустить поток». */
  async startFlow(title: string): Promise<void> {
    await this.shell.goHome();
    const card = await this.bridge.clickFlowCard(title);
    if (!card.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await this.bridge.clickStartButton();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await this.poll();
  }

  /** Единая точка исполнения команд из трея, мини-плеера и горячих клавиш. */
  async run(command: PlayerCommand): Promise<void> {
    if (command === 'quit') return this.shell.quit();
    if (command === 'show') return this.shell.toggleWindow();

    if (!canRun(command, this.state)) {
      // На most команды без трека бессмысленны, но play/pause при пустой плашке
      // может понадобиться, чтобы запустить воспроизведение в самом сайте.
      if (command !== 'toggle') return;
    }

    switch (command) {
      case 'toggle': {
        const action = this.state.status === 'playing' ? 'pause' : 'play';
        const res = await this.bridge.call(action);
        if (res === 'nohandler' || res === 'nobridge' || res.startsWith('error')) {
          await this.bridge.click(action);
        }
        break;
      }
      case 'next': {
        const res = await this.bridge.call('nexttrack');
        if (res !== 'ok') await this.clickWithRetry('next');
        break;
      }
      case 'prev': {
        const res = await this.bridge.call('previoustrack');
        if (res !== 'ok') await this.clickWithRetry('prev');
        break;
      }
      case 'like':
        await this.bridge.click('like');
        break;
      case 'dislike':
        await this.bridge.click('dislike');
        break;
      case 'shuffle':
        await this.bridge.click('shuffle');
        break;
      case 'repeat':
        await this.bridge.click('repeat');
        break;
      case 'queue':
        await this.bridge.click('queue');
        break;
      default:
        break;
    }
    await this.poll();
  }

  /** Переключить форму мини-плеера (трей/горячая клавиша). */
  toggleLayout(): void {
    this.shell.setLayout(this.shell.layout() === 'bar' ? 'wide' : 'bar');
    this.renderTrayMenu(true);
  }

  toggleAlwaysOnTop(): void {
    this.shell.setAlwaysOnTop(!this.shell.alwaysOnTop());
    this.renderTrayMenu(true);
  }

  toggleAutostart(): void {
    this.shell.setAutostart(!this.shell.autostart());
    this.renderTrayMenu(true);
  }
}
