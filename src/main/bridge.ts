import type { WebContents } from 'electron';
import { MEDIA_BRIDGE_SOURCE } from './injection';
import type { RawSnapshot } from '../core/types';
import type { MediaAction } from '../core/playerState';

export type DomAction = 'play' | 'pause' | 'like' | 'dislike' | 'shuffle' | 'repeat' | 'queue' | 'next' | 'prev' | 'hifi';

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout ${ms}ms: ${label}`)), ms);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

const DOM_PATTERNS: Record<DomAction, string> = {
  play: 'воспроизвест|слушать|play',
  pause: 'пауза|pause',
  like: 'нравится|в коллекцию|liked|like',
  dislike: 'не нравится|dislike',
  shuffle: 'перемеш|shuffle',
  repeat: 'повтор|repeat',
  queue: 'очеред|queue',
  next: 'следующ|next',
  prev: 'предыдущ|prev',
  hifi: 'hifi|hi-fi|качество'
};

/**
 * Второй рубеж, когда mediaSession-обработчика нет: у zvuk кнопки плашки — иконки
 * без aria-label, поэтому ищем их по расположению внутри контейнера плеера
 * (три кнопки 32 px подряд: prev, play/pause, next) и по узнаваемым частям классов.
 */
export const __domPatternsForDiag = DOM_PATTERNS;

function domClickScript(action: DomAction): string {
  return `(() => {
    const action = ${JSON.stringify(action)};
    const bar = document.querySelector('[class*="miniPlayerWrapper"]')
      || document.querySelector('[class*="player"][class*="Wrapper"]')
      || document.querySelector('[class*="player"]');
    if (!bar) {
      // Плеер ещё не создан (ничего не играло): на странице трека/альбома запускаем
      // воспроизведение кнопкой самой страницы, а не плашки.
      if (action === 'play') {
        const cands = Array.from(document.querySelectorAll('button')).filter((b) =>
          /^(слушать|воспроизвести|play)/i.test((b.innerText || '').trim())
        );
        const good = cands.find((b) => !/бесплатно/i.test(b.innerText || '')) || cands[0];
        if (good) {
          good.click();
          return { clicked: true, how: 'page-play', text: (good.innerText || '').trim().slice(0, 24) };
        }
      }
      return { clicked: false, reason: 'no-player-bar' };
    }
    const btns = Array.from(bar.querySelectorAll('button'));
    const cls = (b) => String(b.className || '');
    const xOf = (b) => b.getBoundingClientRect().x;
    const rect = (b) => b.getBoundingClientRect();
    const byX = (a, b) => xOf(a) - xOf(b);
    const byCls = (re) => btns.find((b) => re.test(cls(b)));
    // Транспорт: три кнопки ~32px, стоящие вплотную, — prev, play/pause, next.
    // Кнопку обложки обязательно исключаем: она тоже 32×32 и левее транспорта.
    const transportCandidates = btns
      .filter((b) => {
        const r = rect(b);
        return r.width >= 30 && r.width <= 36 && r.height >= 30 && r.height <= 36 && !/cover/i.test(cls(b));
      })
      .sort(byX);
    // Ищем тройку с шагом меньше 40px: так отсекаются случайные кнопки того же размера.
    let transport = transportCandidates;
    for (let i = 0; i + 2 < transportCandidates.length; i++) {
      const a = transportCandidates[i];
      const c = transportCandidates[i + 1];
      const d = transportCandidates[i + 2];
      if (xOf(c) - xOf(a) < 40 && xOf(d) - xOf(c) < 40) {
        transport = [a, c, d];
        break;
      }
    }
    const secondary = btns.filter((b) => /iconWrapper/i.test(cls(b))).sort(byX);
    let target = null;
    let how = '';
    if (action === 'prev' && transport[0]) { target = transport[0]; how = 'transport[0]'; }
    else if ((action === 'play' || action === 'pause') && transport[1]) { target = transport[1]; how = 'transport[1]'; }
    else if (action === 'next' && transport[2]) { target = transport[2]; how = 'transport[2]'; }
    else if (action === 'like') { target = byCls(/btnAdd/i); how = 'btnAdd'; }
    else if (action === 'dislike') { target = byCls(/btnDislike/i); how = 'btnDislike'; }
    else if (action === 'shuffle') { target = secondary[0]; how = 'secondary[0]'; }
    else if (action === 'repeat') { target = secondary[1]; how = 'secondary[1]'; }
    else if (action === 'queue') { target = secondary[2]; how = 'secondary[2]'; }
    else if (action === 'hifi') { target = byCls(/HifiButton|hiFiButton/i); how = 'hifi'; }
    if (!target) return { clicked: false, reason: 'no-target', transport: transport.length, secondary: secondary.length };
    target.click();
    return { clicked: true, how, cls: cls(target).slice(0, 60), buttons: btns.length };
  })()`;
}

/** Мост к странице сайта: инъекция mediaSession-перехватчика и вызовы действий. */
export class SiteBridge {
  private attached = false;
  /** Результат последнего DOM-клика — для диагностики, почему кнопка не сработала. */
  lastClick: unknown = null;

  constructor(
    private readonly wc: WebContents,
    private readonly logger: (message: string) => void = () => {}
  ) {}

  /**
   * Ставим CDP-инъекцию ДО скриптов страницы: только так видно setActionHandler.
   * Вызывать до loadURL.
   */
  async attach(): Promise<void> {
    if (this.attached) return;
    const dbg = this.wc.debugger;
    this.logger('cdp: attach start');
    if (!dbg.isAttached()) dbg.attach('1.3');
    this.logger('cdp: attached');
    // Page.enable нужен, чтобы addScriptToEvaluateOnNewDocument реально применялся.
    // До первой навигации renderer может не ответить, поэтому вызывать после загрузки.
    try {
      await withTimeout(dbg.sendCommand('Page.enable'), 8000, 'Page.enable');
      this.logger('cdp: page enabled');
    } catch (e) {
      this.logger('cdp: Page.enable failed: ' + String(e));
    }
    await withTimeout(
      dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: MEDIA_BRIDGE_SOURCE }),
      8000,
      'addScriptToEvaluateOnNewDocument'
    );
    this.logger('cdp: script added');
    this.attached = true;
  }

  async detach(): Promise<void> {
    try {
      if (this.wc.debugger.isAttached()) this.wc.debugger.detach();
    } catch {
      /* webContents уже разрушен */
    }
    this.attached = false;
  }

  async snapshot(): Promise<RawSnapshot | null> {
    try {
      const value = (await this.wc.executeJavaScript('window.__zs && window.__zs.snapshot ? window.__zs.snapshot() : null', true)) as
        | RawSnapshot
        | null;
      return value ?? null;
    } catch {
      return null;
    }
  }

  /** Вызов обработчика самого сайта (play/pause/next/prev). 'ok' | 'nohandler' | 'nobridge'. */
  async call(action: MediaAction): Promise<string> {
    try {
      const res = (await this.wc.executeJavaScript(
        `window.__zs && window.__zs.call ? window.__zs.call(${JSON.stringify(action)}) : 'nobridge'`,
        true
      )) as string;
      return res;
    } catch (e) {
      return 'error: ' + String(e);
    }
  }

  /** Перемотка: через seekto-обработчик сайта, иначе напрямую элементу. */
  async seek(seconds: number): Promise<string> {
    try {
      return (await this.wc.executeJavaScript(
        `window.__zs && window.__zs.seek ? window.__zs.seek(${Number(seconds)}) : 'nobridge'`,
        true
      )) as string;
    } catch (e) {
      return 'error: ' + String(e);
    }
  }

  /** Громкость: пишем в элемент воспроизведения, который поймал хук play(). */
  async setVolume(value: number): Promise<string> {
    try {
      return (await this.wc.executeJavaScript(
        `window.__zs && window.__zs.setVolume ? window.__zs.setVolume(${Number(value)}) : 'nobridge'`,
        true
      )) as string;
    } catch (e) {
      return 'error: ' + String(e);
    }
  }

  /** Текущий адрес страницы (нужен, чтобы дождаться конца антибот-редиректа). */
  async url(): Promise<string> {
    try {
      return (await this.wc.executeJavaScript('location.href', true)) as string;
    } catch {
      return '';
    }
  }

  /** Список потоков, которые сайт показывает на главной: «Мой поток», настроения, жанры. */
  async listFlows(): Promise<string[]> {
    try {
      const titles = (await this.wc.executeJavaScript(
        `(() => {
          const cards = Array.from(document.querySelectorAll('[class*="ContentListItem_root"], [class*="RecentListening_card"]'));
          const out = [];
          for (const card of cards) {
            const first = (card.innerText || '').split('\\n')[0].trim();
            if (first && !out.includes(first)) out.push(first);
            if (out.length >= 16) break;
          }
          return out;
        })()`,
        true
      )) as string[];
      return Array.isArray(titles) ? titles : [];
    } catch {
      return [];
    }
  }

  /** Клик по карточке потока на главной (карточки — div'ы без ссылок). */
  async clickFlowCard(title: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      return (await this.wc.executeJavaScript(
        `(() => {
          const title = ${JSON.stringify(title)};
          const cards = Array.from(document.querySelectorAll('[class*="ContentListItem_root"], [class*="RecentListening_card"]'));
          const card = cards.find(c => ((c.innerText || '').split('\\n')[0].trim()) === title);
          if (!card) return { ok: false, reason: 'no-card' };
          card.click();
          return { ok: true };
        })()`,
        true
      )) as { ok: boolean; reason?: string };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  }

  /** Кнопка «Запустить поток» / «Слушать» на странице потока. */
  async clickStartButton(): Promise<{ ok: boolean; label?: string }> {
    try {
      const result = (await this.wc.executeJavaScript(
        `(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const re = /(запустить поток|слушать|включить|воспроизвести)/i;
          const hit = btns.find(b => re.test((b.innerText || '').trim()) && !/бесплатно/i.test(b.innerText || ''));
          if (!hit) return { ok: false };
          hit.click();
          return { ok: true, label: (hit.innerText || '').trim().slice(0, 30) };
        })()`,
        true
      )) as { ok: boolean; label?: string };
      this.logger('flow: clickStartButton ' + JSON.stringify(result));
      return result;
    } catch (e) {
      this.logger('flow: clickStartButton failed ' + String(e));
      return { ok: false, label: String(e) };
    }
  }

  /** Клик по кнопке сайта, когда mediaSession действия не предусматривает (лайк, повтор…). */
  async click(action: DomAction): Promise<{ clicked: boolean; how?: string; reason?: string; label?: string }> {
    try {
      const result = (await this.wc.executeJavaScript(domClickScript(action), true)) as {
        clicked: boolean;
        how?: string;
        reason?: string;
        label?: string;
      };
      this.lastClick = { action, ...result, at: new Date().toISOString() };
      return result;
    } catch (e) {
      this.lastClick = { action, error: String(e), at: new Date().toISOString() };
      return { clicked: false };
    }
  }
}
