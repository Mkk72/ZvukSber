/**
 * Скрипт, который внедряется в main world страницы ДО её собственных скриптов
 * (через CDP Page.addScriptToEvaluateOnNewDocument).
 *
 * Задача: перехватить navigator.mediaSession.setActionHandler, чтобы
 *  - знать, какие действия плеер сайта зарегистрировал;
 *  - уметь вызвать обработчик САМОГО САЙТА (а не имитировать клик).
 *
 * Плюс снимок состояния: метаданные, <audio>, playbackState.
 */
export const MEDIA_BRIDGE_SOURCE = String.raw`(() => {
  try {
    if (window.__zs) { return; }
    var st = {
      v: 1,
      handlers: Object.create(null),
      calls: [],
      errors: [],
      hookedAt: new Date().toISOString()
    };
    window.__zs = st;

    st.call = function (action) {
      var h = st.handlers[action];
      if (typeof h === 'function') {
        try {
          h({ action: action });
          st.calls.push({ action: action, at: Date.now(), ok: true });
          return 'ok';
        } catch (e) {
          st.calls.push({ action: action, at: Date.now(), ok: false, err: String(e) });
          return 'throw:' + e;
        }
      }
      return 'nohandler';
    };

    // Позиция: сайт играет через Web Audio, элемента <audio> может не быть вовсе.
    // Тогда единственный источник — navigator.mediaSession.setPositionState.
    st.position = null;
    st.mediaEls = [];
    try {
      var origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        try {
          if (st.mediaEls.indexOf(this) === -1) st.mediaEls.push(this);
        } catch (e) {}
        return origPlay.apply(this, arguments);
      };
    } catch (e) {
      st.errors.push('play hook: ' + e);
    }
    try {
      var ms0 = navigator.mediaSession;
      if (ms0 && typeof ms0.setPositionState === 'function') {
        var origPos = ms0.setPositionState;
        var wrappedPos = function (state) {
          if (state) {
            st.position = {
              position: state.position,
              duration: state.duration,
              rate: state.playbackRate,
              at: Date.now()
            };
          }
          try {
            return origPos.call(ms0, state);
          } catch (e) {
            st.errors.push('setPositionState: ' + e);
          }
        };
        try { ms0.setPositionState = wrappedPos; } catch (e) { st.errors.push('pos wrap: ' + e); }
        try {
          var p0 = Object.getPrototypeOf(ms0);
          if (p0 && p0 !== Object.prototype) p0.setPositionState = wrappedPos;
        } catch (e) { st.errors.push('pos proto wrap: ' + e); }
      }
    } catch (e) {
      st.errors.push('position hook: ' + e);
    }

    st.snapshot = function () {
      var ms = navigator.mediaSession;
      var m = ms && ms.metadata;
      var medias = Array.prototype.slice.call(document.querySelectorAll('audio,video'));
      // Плеер сайта может держать элемент вне DOM — тогда он есть только в st.mediaEls.
      try {
        (st.mediaEls || []).forEach(function (el) {
          if (medias.indexOf(el) === -1) medias.push(el);
        });
      } catch (e) {}
      var controls = [];
      var re = /(пауза|воспроизвест|слушать|следующ|предыдущ|нравится|перемешать|повтор|очеред|громкость|hifi|качеств)/i;
      var nodes = document.querySelectorAll('button,[role="button"],[aria-label]');
      for (var i = 0; i < nodes.length && controls.length < 40; i++) {
        var el = nodes[i];
        var label = (el.getAttribute('aria-label') || '').trim();
        if (!label || !re.test(label)) continue;
        controls.push({
          label: label.slice(0, 60),
          pressed: el.getAttribute('aria-pressed'),
          tag: el.tagName.toLowerCase()
        });
      }
      return {
        handlers: Object.keys(st.handlers).filter(function (k) {
          return typeof st.handlers[k] === 'function';
        }),
        metadata: m
          ? {
              title: m.title,
              artist: m.artist,
              album: m.album,
              artwork: (m.artwork || []).slice(0, 3).map(function (x) { return x.src; })
            }
          : null,
        positionState: st.position,
        controls: controls,
        mediaCount: medias.length,
        media: medias.map(function (a) {
          return {
            tag: a.tagName.toLowerCase(),
            src: (a.currentSrc || a.src || '').slice(0, 160),
            paused: a.paused,
            currentTime: Math.round(a.currentTime * 10) / 10,
            duration: a.duration,
            readyState: a.readyState,
            volume: a.volume
          };
        }),
        playbackState: ms ? ms.playbackState : null,
        errors: st.errors
      };
    };

    var ms = navigator.mediaSession;
    if (!ms || typeof ms.setActionHandler !== 'function') {
      st.errors.push('no mediaSession.setActionHandler');
      return;
    }
    var orig = ms.setActionHandler;
    var wrapped = function (action, handler) {
      st.handlers[action] = handler || null;
      try {
        return orig.call(ms, action, handler);
      } catch (e) {
        st.errors.push(action + ': ' + e);
      }
    };
    try { ms.setActionHandler = wrapped; } catch (e) { st.errors.push('instance wrap: ' + e); }
    try {
      var proto = Object.getPrototypeOf(ms);
      if (proto && proto !== Object.prototype) { proto.setActionHandler = wrapped; }
    } catch (e) { st.errors.push('proto wrap: ' + e); }
  } catch (e) {
    window.__zs = { fatal: String(e) };
  }
})();`;
