'use strict';

/**
 * browser/device-presets.js — presets de device e cálculo de escala do dock.
 *
 * Puro e sem dependências: dá para testar sem Electron (test/device-emulation.test.js).
 * Quem aplica é o main, via `webContents.enableDeviceEmulation(params)`.
 *
 * A ideia central do dock: **a largura física do painel não é o viewport da
 * página**. Com `viewSize` + `scale`, uma <webview> de 560px reais renderiza a
 * página como 1440×900 e a desenha a 39%. Por isso escolher "Desktop 1920" custa
 * exatamente os mesmos pixels de tela que escolher "iPhone" — muda só a escala,
 * nunca a largura que os panes do grid perdem.
 *
 * `deviceScaleFactor: 0` significa "usa o do host" (Retina = 2). Só os presets
 * móveis cravam um dsf, porque faz parte do que se está emulando.
 *
 * `screenPosition: 'mobile'` liga a semântica de viewport móvel do Chromium:
 * página SEM <meta name="viewport"> cai no fallback de 980px em vez de usar
 * `viewSize.width`. Isso é fiel ao aparelho real (verificado no spike de
 * 2026-08-01), não um bug daqui — produto real declara a meta e renderiza 393.
 *
 * Carregado dos dois lados: `require()` no main/testes e `<script>` clássico no
 * renderer (vira `window.NoryaDevice`), como os demais scripts de renderer/.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.NoryaDevice = api;
})(typeof window !== 'undefined' ? window : null, function () {

  /** Altura usada quando o chamador (agente via MCP) só informa a largura. */
  const DEFAULT_HEIGHT = 900;

  /** Abaixo disto, emulamos com semântica de viewport móvel. */
  const MOBILE_MAX_WIDTH = 768;

  const PRESETS = [
    { id: 'responsive',    label: 'Responsive',     viewSize: null },
    { id: 'iphone-15-pro', label: 'iPhone 15 Pro',  viewSize: { width: 393,  height: 852  }, deviceScaleFactor: 3, screenPosition: 'mobile' },
    { id: 'ipad',          label: 'iPad',           viewSize: { width: 834,  height: 1194 }, deviceScaleFactor: 2, screenPosition: 'mobile' },
    { id: 'desktop-1280',  label: 'Desktop 1280',   viewSize: { width: 1280, height: 800  } },
    { id: 'desktop-1440',  label: 'Desktop 1440',   viewSize: { width: 1440, height: 900  } },
    { id: 'desktop-1920',  label: 'Desktop 1920',   viewSize: { width: 1920, height: 1080 } },
  ];

  const DEFAULT_PRESET_ID = 'desktop-1440';

  const positivo = v => typeof v === 'number' && isFinite(v) && v > 0;

  /**
   * Escala que faz `viewportWidth` caber em `availableWidth`. Nunca amplia — uma
   * página de 393px num dock de 900 deve aparecer 1:1, não esticada. Entrada
   * inválida cai em 1 em vez de 0/NaN, que apagaria a página da tela.
   */
  function computeScale(viewportWidth, availableWidth) {
    if (!positivo(viewportWidth) || !positivo(availableWidth)) return 1;
    return Math.min(1, availableWidth / viewportWidth);
  }

  function montar(viewSize, availableWidth, { deviceScaleFactor, screenPosition } = {}) {
    return {
      screenPosition: screenPosition || (viewSize.width < MOBILE_MAX_WIDTH ? 'mobile' : 'desktop'),
      screenSize: { width: viewSize.width, height: viewSize.height },
      viewPosition: { x: 0, y: 0 },
      viewSize: { width: viewSize.width, height: viewSize.height },
      deviceScaleFactor: deviceScaleFactor || 0,
      scale: computeScale(viewSize.width, availableWidth),
    };
  }

  /**
   * @returns {object|null} params para enableDeviceEmulation, ou null quando o
   *          preset é o responsivo / não existe — o chamador então chama
   *          `disableDeviceEmulation()`.
   */
  function emulationParams(presetId, availableWidth, opts) {
    const preset = PRESETS.find(p => p.id === presetId);
    if (!preset || !preset.viewSize) return null;
    const { width, height } = preset.viewSize;
    const viewSize = (opts && opts.rotated)
      ? { width: height, height: width }
      : { width, height };
    return montar(viewSize, availableWidth, preset);
  }

  /**
   * Caminho do `browser_set_viewport` do MCP: o agente manda largura/altura
   * cruas. Sem largura → null (volta ao responsivo), em vez do no-op silencioso
   * que existia antes de 2026-08-01.
   */
  function viewportParams(params, availableWidth) {
    const width = params && params.width;
    if (!positivo(width)) return null;
    const height = positivo(params.height) ? params.height : DEFAULT_HEIGHT;
    return montar({ width, height }, availableWidth);
  }

  return { PRESETS, DEFAULT_PRESET_ID, DEFAULT_HEIGHT, MOBILE_MAX_WIDTH, computeScale, emulationParams, viewportParams };
});
