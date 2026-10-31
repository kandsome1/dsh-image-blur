/**
 * client.js — 浏览器半边：让 DSH 渲染出来的图片「默认模糊」，图片右上角挂一颗
 * 「显示 / 模糊」按钮，点了「显示」才看清（NSFW 那种模式）。
 *
 * 为什么是「盯 <img>」而不是「换某个槽位」——依据 dsh-qwen-paint 的 README
 * 「图片是怎么显示在聊天框里的（原理，改之前务必看）」那一节：
 *
 *   ① 正文 Markdown 的 `![](<绝对路径>)`：客户端 `fileMediaUrl()` 把本地绝对路径
 *      重写成 `<base>/api/file?path=…`，打到内核已认证的 `/api/file` 路由取字节，
 *      渲染成**真 <img>**。这是官方设计的行内显示路径。
 *   ② 客户端自定义 `toolview`（`draw_image` / `read_image` 那种卡片）里，插件自己
 *      写 `<img src="api/file?path=…">`，也是**真 <img>**。
 *
 * 两条路最后都落在同一批 DOM 节点上，所以本插件不做任何「替换渲染器」的动作：
 *
 *   - 模糊 = 给 <img> 加一个我们自己拥有的属性 `data-dsh-imgblur`，样式表按属性下
 *     发 `filter: blur(...)`。**不动 DOM 结构、不移动节点、不碰 className/style**，
 *     于是 React 重渲染（含流式输出时的每帧重渲染）不会因为多出来的包裹层报
 *     `removeChild` 崩掉，图片文件本身也一个字节都不改。
 *   - 按钮 = 在 `shell.overlay`（frame 级穿透浮层，replaceRisk: none）里渲染一层
 *     自己的浮层，给每张被模糊的图绝对定位一颗 chip；位置每帧按
 *     `getBoundingClientRect()` 跟随滚动、窗口缩放与图片加载。
 *   - 开关 = 在 `settings.general.item`（通用设置里的加行槽位）加一行：总开关 +
 *     模糊强度，写 localStorage，改完立刻生效。
 *
 * 图片「显示」过的状态按 src 记住（同一个 src 的所有实例一起显示），所以切会话、
 * 重渲染、再滚回来看都不会莫名其妙又糊上。
 *
 * 作用域（0.2.0 起）：**只有会话正文里的图片参与**。判据是我们自己插进会话流
 * （`conversation.chat.turnTail`）和输入框下方（`conversation.composer.dock`）的两个
 * 零尺寸锚点 —— 取它们的最近公共祖先当作用域容器。侧栏、右侧面板、插件市场、
 * 设置页、别的插件的工具面板都在容器之外，一律不碰；并且判定改用**渲染尺寸**
 * （插件图标原图再大，显示成 20px 也不参与）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-image-blur',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useRef, useState, useEffect } = React;

    const NS = 'dsh-image-blur';
    const ATTR = 'data-dsh-imgblur';

    // ── 文案（本机兜底用；能拿到 locale 服务时以语言包为准）────────────────
    const TEXT = {
      zh: {
        'chip.show': '显示',
        'chip.blur': '模糊',
        'chip.showTitle': '这张图片已模糊，点击显示',
        'chip.blurTitle': '重新模糊这张图片',
        'chip.showAria': '显示这张被模糊的图片',
        'chip.blurAria': '重新模糊这张图片',
        'settings.title': '图片模糊',
        'settings.desc': '只糊会话正文里的图片：右上角点「显示」才看清，点「模糊」盖回去。侧栏、右侧面板、插件页面与图标一概不动，图片文件本身不变。',
        'settings.offDesc': '已关闭：图片按原样显示，不出现「显示 / 模糊」按钮。',
        'settings.strength': '强度',
        strengthLight: '轻',
        strengthNormal: '中',
        strengthStrong: '强',
      },
      en: {
        'chip.show': 'Show',
        'chip.blur': 'Blur',
        'chip.showTitle': 'This image is blurred — click to show it',
        'chip.blurTitle': 'Blur this image again',
        'chip.showAria': 'Show this blurred image',
        'chip.blurAria': 'Blur this image again',
        'settings.title': 'Image blur',
        'settings.desc': 'Blurs images in the conversation body only; click “Show” in the corner to reveal, “Blur” to cover it again. Side panels, plugin pages and icons stay untouched.',
        'settings.offDesc': 'Off: images render as-is and no Show / Blur button appears.',
        'settings.strength': 'Strength',
        strengthLight: 'Low',
        strengthNormal: 'Medium',
        strengthStrong: 'High',
      },
    };

    let localeCtx = null;
    let translate = null;

    function activeLang() {
      try {
        const loc = localeCtx && localeCtx.get ? localeCtx.get('locale') : null;
        const snap = loc && typeof loc.getLocale === 'function' ? loc.getLocale() : null;
        const id = String((snap && snap.active) || '');
        if (id) return /^zh/i.test(id) ? 'zh' : 'en';
      } catch (err) {
        /* 语言服务不可用：走浏览器语言 */
      }
      const navi = String((typeof navigator !== 'undefined' && navigator.language) || 'en');
      return /^zh/i.test(navi) ? 'zh' : 'en';
    }

    function t(key) {
      try {
        const out = translate ? translate(key) : key;
        if (out && out !== key) return out;
      } catch (err) {
        /* 没注册成功就用本机字典 */
      }
      const lang = activeLang();
      const dict = TEXT[lang] || TEXT.en;
      return dict[key] != null ? dict[key] : TEXT.en[key] != null ? TEXT.en[key] : key;
    }

    // ── 设置：localStorage，改完即时生效 ────────────────────────────────────
    const LS_KEY = 'dsh-image-blur:settings:v1';
    const STRENGTH = { light: 10, normal: 20, strong: 36 };
    const STRENGTH_KEYS = ['light', 'normal', 'strong'];
    const settings = { enabled: true, strength: 'normal', minPx: 120 };
    const subs = new Set();

    function loadSettings() {
      try {
        const raw = window.localStorage ? window.localStorage.getItem(LS_KEY) : null;
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;
        if (typeof parsed.enabled === 'boolean') settings.enabled = parsed.enabled;
        if (STRENGTH[parsed.strength]) settings.strength = parsed.strength;
        if (typeof parsed.minPx === 'number' && parsed.minPx >= 32) settings.minPx = parsed.minPx;
      } catch (err) {
        /* 隐私模式 / 配额满：用默认值，功能照常 */
      }
    }

    function saveSettings() {
      try {
        if (window.localStorage) window.localStorage.setItem(LS_KEY, JSON.stringify(settings));
      } catch (err) {
        /* 存不了就只在本会话生效 */
      }
    }

    function pushCssVars() {
      const root = document.documentElement;
      if (!root || !root.style || typeof root.style.setProperty !== 'function') return;
      root.style.setProperty('--dsh-imgblur-radius', (STRENGTH[settings.strength] || 20) + 'px');
    }

    function applySettings(patch) {
      if (!patch || typeof patch !== 'object') return;
      const structural = 'enabled' in patch || 'minPx' in patch;
      if (typeof patch.enabled === 'boolean') settings.enabled = patch.enabled;
      if (STRENGTH[patch.strength]) settings.strength = patch.strength;
      if (typeof patch.minPx === 'number' && patch.minPx >= 32) settings.minPx = patch.minPx;
      saveSettings();
      pushCssVars();
      // 只换强度不必拆了重来（会闪一下），改开关/阈值才需要重新扫描。
      if (structural) engine.refresh();
      subs.forEach((fn) => {
        try {
          fn();
        } catch (err) {
          /* 单个订阅者出错不影响别人 */
        }
      });
    }

    // ── 样式 ───────────────────────────────────────────────────────────────
    const CSS = [
      '/* 模糊由我们自己的属性驱动：不碰 className / style，React 重渲染也不会打架 */',
      '/* filter:blur 会往元素外溢，观感上「模糊范围比图片大」；inset(0 round …) 把',
      '   滤镜输出裁回元素自己的圆角矩形，圆角用元素自身 computed border-radius 喂进来。 */',
      'img[' + ATTR + ']{',
      '  clip-path: inset(0 round var(--dsh-imgblur-clip, 0px));',
      '  -webkit-clip-path: inset(0 round var(--dsh-imgblur-clip, 0px));',
      '}',
      '/* 预糊兜底：会话容器被我们打上 scope 之后，里面「还没被 JS 登记」的图片也先糊住，',
      '   这样切会话 / 新渲染的第一帧不会露出裸图；够不上的（图标等）会被打上 off 立刻恢复。 */',
      '[data-dsh-imgblur-scope] img:not([' + ATTR + ']):not([data-dsh-imgblur-off="1"]):not([data-dsh-imgblur-ignore="1"]){',
      '  filter: blur(var(--dsh-imgblur-radius, 20px)) saturate(.55) brightness(.94) !important;',
      '  clip-path: inset(0 round var(--dsh-imgblur-clip, 0px));',
      '  -webkit-clip-path: inset(0 round var(--dsh-imgblur-clip, 0px));',
      '}',
      'img[' + ATTR + '="hidden"]{',
      '  filter: blur(var(--dsh-imgblur-radius, 20px)) saturate(.55) brightness(.94) !important;',
      '  transition: filter 180ms ease;',
      '  cursor: zoom-in;',
      '}',
      'img[' + ATTR + '="shown"]{',
      '  filter: none !important;',
      '  transition: filter 180ms ease;',
      '  cursor: zoom-out;',
      '}',
      '.dsh-imgblur-layer{position:fixed;inset:0;pointer-events:none;z-index:30;}',
      '.dsh-imgblur-anchor{position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none;}',
      '.dsh-imgblur-chip{',
      '  position:absolute;left:0;top:0;pointer-events:auto;display:inline-flex;align-items:center;gap:5px;',
      '  height:24px;margin:0;padding:0 9px;border-radius:999px;',
      '  border:1px solid var(--dsw-alias-border-l1);',
      '  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);',
      '  font-family:inherit;font-size:12px;font-weight:500;line-height:1;letter-spacing:.02em;white-space:nowrap;',
      '  cursor:pointer;-webkit-user-select:none;user-select:none;',
      '  box-shadow:0 2px 10px rgba(0,0,0,.22);opacity:1;will-change:transform;',
      '  transition:opacity 140ms ease,background-color 140ms ease,border-color 140ms ease;',
      '}',
      '.dsh-imgblur-chip:hover{background:var(--dsw-alias-bg-overlay);border-color:var(--dsw-alias-border-l2);}',
      '.dsh-imgblur-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.dsh-imgblur-chip svg{display:block;opacity:.85;}',
      '.dsh-imgblur-chip[data-shown="1"]{opacity:0;}',
      '.dsh-imgblur-chip[data-shown="1"][data-hot="1"],.dsh-imgblur-chip[data-shown="1"]:hover{opacity:1;}',
      '/* 缩略图（多图附件的紧凑格子）上换成只有眼睛的小圆按钮，别把图盖满 */',
      '.dsh-imgblur-chip[data-compact="1"]{width:24px;height:22px;padding:0;justify-content:center;gap:0;}',
      '.dsh-imgblur-chip[data-compact="1"] span{display:none;}',
      '.dsh-imgblur-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.dsh-imgblur-col{min-width:0;display:flex;flex-direction:column;gap:3px;}',
      '.dsh-imgblur-name{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;}',
      '.dsh-imgblur-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;}',
      '.dsh-imgblur-ctrls{display:flex;align-items:center;gap:10px;flex:none;}',
      '.dsh-imgblur-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;',
      '  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);}',
      '.dsh-imgblur-seg-label{color:var(--dsw-alias-label-secondary);font-size:11px;padding:0 6px 0 4px;}',
      '.dsh-imgblur-seg-btn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);',
      '  font-family:inherit;font-size:12px;line-height:1;padding:5px 8px;border-radius:6px;cursor:pointer;}',
      '.dsh-imgblur-seg-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);}',
      '.dsh-imgblur-seg-btn.is-on{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.12);}',
      '.dsh-imgblur-seg-btn:disabled{opacity:.45;cursor:default;}',
      '.dsh-imgblur-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border-radius:999px;',
      '  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;',
      '  transition:background-color 160ms ease,border-color 160ms ease;}',
      '.dsh-imgblur-switch.is-on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}',
      '.dsh-imgblur-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;',
      '  background:var(--dsw-alias-label-secondary);transition:transform 160ms ease,background-color 160ms ease;}',
      '.dsh-imgblur-switch.is-on .dsh-imgblur-knob{transform:translateX(16px);background:var(--dsw-alias-bg-base);}',
    ].join('\n');

    // 样式表自己插一个 <style>：行为确定、可标可删，且不依赖某个内建是否可用。
    function installCss(css) {
      const el = document.createElement('style');
      el.setAttribute('data-dsh-image-blur', '');
      el.textContent = css;
      (document.head || document.documentElement).appendChild(el);
      return function disposeStyle() {
        try {
          el.remove();
        } catch (err) {
          /* ignore */
        }
      };
    }

    // ── 会话作用域：只有「对话正文」里的图片才参与 ─────────────────────────
    // 判据既不用宿主的 class（会变），也不靠几何猜测，而是**我们自己插进会话里的
    // 两个零尺寸锚点**：
    //   ① `conversation.chat.turnTail`（每轮一个，落在消息流内部）
    //   ② `conversation.composer.dock`（输入框下方，随会话常驻）
    // 二者的最近公共祖先 = 会话正文容器（消息流 + 输入区都在里面）。
    // 侧栏、右侧面板、插件市场、设置页、别的插件自绘的工具面板都在它之外 —— 不参与。
    const anchors = { dock: new Set(), flow: new Set() };
    const scopeCache = { at: 0, node: null };

    function ancestry(node) {
      const chain = [];
      let el = node;
      while (el) {
        chain.push(el);
        el = el.parentElement;
      }
      return chain;
    }

    // 最近公共祖先：chain 是 [自己 … html]，第一个公共节点就是最深的那个。
    function lowestCommonAncestor(nodes) {
      const live = nodes.filter((n) => n && n.isConnected);
      if (live.length < 2) return null;
      const chains = live.map(ancestry);
      for (const candidate of chains[0]) {
        let shared = true;
        for (let i = 1; i < chains.length; i += 1) {
          if (chains[i].indexOf(candidate) === -1) {
            shared = false;
            break;
          }
        }
        if (shared) return candidate;
      }
      return null;
    }

    function firstLive(set) {
      for (const el of set) {
        if (el && el.isConnected) return el;
      }
      return null;
    }

    // 退路一：从锚点往上找第一个真正在滚动的容器（消息列表就是滚动的）。
    function scrollScope(anchor) {
      let el = anchor.parentElement;
      for (let i = 0; el && i < 14; i += 1) {
        try {
          const s = window.getComputedStyle(el);
          if (s && /(auto|scroll|overlay)/.test(String(s.overflowY || ''))) return el;
        } catch (err) {
          /* 跨域 iframe 之类，忽略 */
        }
        el = el.parentElement;
      }
      return null;
    }

    // 退路二：往上找到第一个「里面真的有图」的祖先（输入框下面是消息流所在的那层）。
    function fallbackScope(anchor) {
      let el = anchor.parentElement;
      for (let i = 0; el && i < 8; i += 1) {
        try {
          if (el.querySelector && el.querySelector('img')) return el;
        } catch (err) {
          /* ignore */
        }
        el = el.parentElement;
      }
      return anchor.parentElement || null;
    }

    function conversationScope() {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const cached = scopeCache.node;
      if (cached && cached.isConnected && now - scopeCache.at < 400) return cached;

      const flow = firstLive(anchors.flow);
      const dock = firstLive(anchors.dock);
      let node = flow && dock ? lowestCommonAncestor([flow, dock]) : null;
      if (node === document.body || node === document.documentElement) node = null;
      // 兜一层：公共祖先万一窜到应用根（`body > #root` 那一层）就不认，退回更紧的判据。
      const appRoot = document.body ? document.body.firstElementChild : null;
      if (node && appRoot && node === appRoot) node = null;
      if (!node && flow) node = scrollScope(flow);
      if (!node && dock) node = fallbackScope(dock);
      if (!node && flow) node = fallbackScope(flow);
      if (!node && cached && cached.isConnected) node = cached; // 守住上一次的有效作用域，避免抖动

      scopeCache.node = node || null;
      scopeCache.at = now;
      if (scopeCache.node) markScope(scopeCache.node);
      return scopeCache.node;
    }

    function resetScope() {
      scopeCache.node = null;
      scopeCache.at = 0;
    }

    // 会话容器的 scope 标记：CSS 靠它做「预糊」。只在节点真的换了的时候改属性。
    let scopeMarked = null;
    function markScope(node) {
      const next = node && node.setAttribute ? node : null;
      if (next === scopeMarked) return;
      if (scopeMarked && scopeMarked.removeAttribute) {
        try {
          scopeMarked.removeAttribute('data-dsh-imgblur-scope');
        } catch (err) {
          /* ignore */
        }
      }
      scopeMarked = next;
      if (scopeMarked) {
        try {
          scopeMarked.setAttribute('data-dsh-imgblur-scope', '1');
        } catch (err) {
          /* ignore */
        }
      }
    }

    // ── 引擎：观察 <img>、下发属性、摆放按钮 ───────────────────────────────
    // 显示状态按 src 记在 window 上：HMR / 重载之后不必重新点一遍。
    if (!(window.__dshImageBlurRevealed instanceof Map)) window.__dshImageBlurRevealed = new Map();

    const engine = {
      started: false,
      layer: null,
      cssOff: null,
      mo: null,
      rafId: 0,
      scanTimer: 0,
      sweepTimer: 0,
      tracked: new Map(),
      revealed: window.__dshImageBlurRevealed,

      start() {
        if (this.started) return;
        // 单例仲裁：HMR 会留下上一份实例，先把它的监听、样式、按钮收干净。
        try {
          if (typeof window.__dshImageBlurStop === 'function') window.__dshImageBlurStop();
        } catch (err) {
          /* 上一份已经不在了 */
        }
        this.started = true;
        loadSettings();
        pushCssVars();
        this.cssOff = installCss(CSS);
        document.addEventListener('pointerdown', onDocPointerDown, true);
        document.addEventListener('click', onDocClick, true);
        document.addEventListener('pointerover', onDocPointerOver, true);
        document.addEventListener('pointerout', onDocPointerOut, true);
        document.addEventListener('load', onDocLoad, true);
        try {
          // MutationObserver 的回调是微任务，跑在浏览器绘制之前：新图片插进 DOM 的
          // 同一个任务里就把属性打上，所以第一帧就是糊的（切会话不再闪裸图）。
          this.mo = new MutationObserver((records) => {
            try {
              this.onMutations(records);
            } catch (err) {
              this.queueScan();
            }
          });
          this.mo.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src'],
          });
        } catch (err) {
          this.mo = null;
        }
        window.__dshImageBlurStop = () => engine.stop();
        this.queueScan();
        // 兜底巡检：懒加载 / 从 display:none 里刚出来的图不会触发 mutation，
        // 1.5 秒扫一遍 document.images 把它们捡起来（页面不可见时不做）。
        this.sweepTimer = setInterval(() => {
          if (document.hidden) return;
          try {
            this.scan();
            this.refreshClippers();
          } catch (err) {
            /* 下一轮再来 */
          }
          this.kick();
        }, 1500);
      },

      stop() {
        if (!this.started) return;
        this.started = false;
        try {
          if (this.mo) this.mo.disconnect();
        } catch (err) {
          /* ignore */
        }
        this.mo = null;
        document.removeEventListener('pointerdown', onDocPointerDown, true);
        document.removeEventListener('click', onDocClick, true);
        document.removeEventListener('pointerover', onDocPointerOver, true);
        document.removeEventListener('pointerout', onDocPointerOut, true);
        document.removeEventListener('load', onDocLoad, true);
        if (this.scanTimer) {
          clearTimeout(this.scanTimer);
          this.scanTimer = 0;
        }
        if (this.sweepTimer) {
          clearInterval(this.sweepTimer);
          this.sweepTimer = 0;
        }
        if (this.rafId) {
          cancelAnimationFrame(this.rafId);
          this.rafId = 0;
        }
        Array.from(this.tracked.keys()).forEach((img) => this.drop(img));
        try {
          if (this.cssOff) this.cssOff();
        } catch (err) {
          /* ignore */
        }
        this.cssOff = null;
        this.layer = null;
        markScope(null);
        if (window.__dshImageBlurStop) window.__dshImageBlurStop = null;
      },

      // 图片是否值得管：必须落在会话正文容器里，且**按渲染尺寸**够大。
      // 用渲染尺寸而不是 naturalWidth，是因为插件图标常常是 512px 的原图缩到
      // 20–48px 显示 —— 按原图判会把整个界面糊成一片。
      eligible(img) {
        if (!img || img.tagName !== 'IMG') return false;
        if (img.closest && img.closest('[data-dsh-imgblur-skip]')) return false;
        if (img.getAttribute('data-dsh-imgblur-ignore') === '1') return false;
        const scope = conversationScope();
        if (!scope || typeof scope.contains !== 'function' || !scope.contains(img)) return false;
        if (!img.complete || (img.naturalWidth || 0) < 24) return false; // 未解码 / 1px 占位图
        const w = img.clientWidth || 0;
        const h = img.clientHeight || 0;
        if (w < 28 || h < 28) return false;
        // 两条判据取「或」：
        //   ① 原图本身就是照片 / 渲染图（≥200×200）且显示得不小于一枚缩略图（≥56×56）
        //      —— 多图附件会被压成紧凑格子（64–96px），只看显示尺寸会把它们漏掉；
        //   ② 显示得够大（≥minPx 宽、≥48 高）—— 正文里的大图走这条。
        // 图标：原图再大，显示通常也只有 20–48px，两条都不满足（56 这道门槛就是拿来挡图标的）。
        const photoLike =
          (img.naturalWidth || 0) >= 200 && (img.naturalHeight || 0) >= 200 && w >= 56 && h >= 56;
        return photoLike || (w >= settings.minPx && h >= 48);
      },

      // 取消 CSS 预糊。只在「已经解码且量到尺寸」之后才下结论：正在加载的图如果被
      // 提前打上 off，加载完成前就是裸的，之后又补上模糊 —— 那就是一次可见的闪。
      markOff(img) {
        if (!img || !img.complete || !img.clientWidth || !img.clientHeight) return;
        try {
          img.setAttribute('data-dsh-imgblur-off', '1');
        } catch (err) {
          /* ignore */
        }
      },

      // 取当前作用域；缓存里的容器已经不在文档里（切了会话）就丢掉重算一次。
      currentScope() {
        let scope = conversationScope();
        if (!scope || !scope.isConnected) {
          resetScope();
          scope = conversationScope();
        }
        return scope && typeof scope.contains === 'function' ? scope : null;
      },

      // 已经被登记的图如果跑出作用域（换会话、切视图、组件被挪走），立刻撤掉。
      revalidate() {
        const scope = conversationScope();
        const stale = [];
        this.tracked.forEach((entry, img) => {
          if (!scope || typeof scope.contains !== 'function' || !scope.contains(img)) stale.push(img);
        });
        stale.forEach((img) => this.drop(img));
      },

      scan() {
        if (!settings.enabled) {
          markScope(null); // 关掉开关时连 CSS 预糊一起停
          return;
        }
        this.revalidate();
        const scope = this.currentScope();
        let imgs = [];
        try {
          imgs = Array.from(document.images || []);
        } catch (err) {
          imgs = [];
        }
        for (const img of imgs) {
          if (this.tracked.has(img)) continue;
          if (!scope || typeof scope.contains !== 'function' || !scope.contains(img)) continue;
          if (this.eligible(img)) {
            this.track(img);
            continue;
          }
          // 在会话里但不够格（图标、状态点）：打上 off 取消 CSS 预糊，保持原样。
          this.markOff(img);
        }
      },

      // 新插入的图片走这条路：同步登记（MutationObserver 回调是微任务，早于绘制），
      // 于是第一帧就是模糊的，不会先露裸图。
      trackNow(img) {
        if (!settings.enabled) return;
        if (!img || img.tagName !== 'IMG' || this.tracked.has(img)) return;
        let scope = conversationScope();
        // 刚切会话时缓存里可能还是上一个会话的容器，装不下这张新图 —— 丢掉缓存重算一次。
        if (!scope || !scope.isConnected) {
          resetScope();
          scope = conversationScope();
        }
        if (!scope || typeof scope.contains !== 'function') {
          this.queueScan();
          return;
        }
        if (!scope.contains(img)) return;
        if (this.eligible(img)) {
          this.track(img);
          return;
        }
        this.markOff(img);
      },

      onMutations(records) {
        let touched = false;
        for (let i = 0; i < records.length; i += 1) {
          const rec = records[i];
          if (rec.type !== 'childList') continue;
          const added = rec.addedNodes;
          for (let j = 0; j < added.length; j += 1) {
            const node = added[j];
            if (!node || node.nodeType !== 1) continue;
            if (node.tagName === 'IMG') {
              this.trackNow(node);
              touched = true;
              continue;
            }
            if (node.querySelectorAll) {
              const imgs = node.querySelectorAll('img');
              for (let k = 0; k < imgs.length; k += 1) {
                this.trackNow(imgs[k]);
                touched = true;
              }
            }
          }
        }
        if (touched) {
          try {
            this.layout();
          } catch (err) {
            /* ignore */
          }
          this.kick();
        }
        // 其余变化（文本流式、属性改）仍走节流全量扫描。
        this.queueScan();
      },

      // 图片外面每一层「会裁剪的祖先」（消息列表就是滚动容器）。chip 只在图片
      // 真正露出来的那块区域里画 —— 图滚出对话框时按钮跟着消失，不会飘到框外面。
      clippersFor(img) {
        const out = [];
        let el = img.parentElement;
        for (let i = 0; el && i < 16 && out.length < 4; i += 1) {
          try {
            const cs = window.getComputedStyle(el);
            const ov = String(cs.overflowY || '') + ' ' + String(cs.overflowX || '');
            if (/(hidden|auto|scroll|overlay|clip)/.test(ov)) out.push(el);
          } catch (err) {
            /* ignore */
          }
          el = el.parentElement;
        }
        return out;
      },

      // 容器可能晚于图片出现（用户消息先本地回显、再变成正式消息节点），
      // 所以每秒一次把已登记图片的裁剪祖先重算一遍，免得用着用着失准。
      refreshClippers() {
        this.tracked.forEach((entry, img) => {
          if (!img || !img.isConnected) return;
          try {
            entry.clippers = this.clippersFor(img);
            entry.clipAt = 0;
            // 图片被放大/缩小时（窗口缩放、附件从缩略图变成大图）顺手切换紧凑按钮。
            const small = (img.clientWidth || 0) < 140 || (img.clientHeight || 0) < 90;
            if (entry.chip && entry.compact !== small) {
              entry.compact = small;
              entry.chip.dataset.compact = small ? '1' : '0';
              entry.width = entry.chip.offsetWidth || 0;
            }
          } catch (err) {
            /* ignore */
          }
        });
      },

      track(img) {
        const src = img.currentSrc || img.src || '';
        const shown = this.revealed.has(src);
        const entry = { src, shown, chip: null, label: null, width: 0, clippers: this.clippersFor(img) };
        this.tracked.set(img, entry);
        try {
          img.removeAttribute('data-dsh-imgblur-off');
          img.setAttribute(ATTR, shown ? 'shown' : 'hidden');
          // 把元素自己的圆角喂给 clip-path，裁掉裁剪框后不会把圆角图片切成直角。
          const cs = window.getComputedStyle(img);
          const radius = (cs && cs.borderRadius) || '0px';
          if (radius && radius !== '0px') img.style.setProperty('--dsh-imgblur-clip', radius);
        } catch (err) {
          /* ignore */
        }
        this.ensureChip(img, entry);
        this.kick();
      },

      drop(img) {
        const entry = this.tracked.get(img);
        this.tracked.delete(img);
        try {
          img.removeAttribute(ATTR);
          img.style.removeProperty('--dsh-imgblur-clip');
        } catch (err) {
          /* ignore */
        }
        if (entry && entry.chip) {
          try {
            entry.chip.remove();
          } catch (err) {
            /* ignore */
          }
        }
      },

      ensureChip(img, entry) {
        if (!this.layer || !entry || entry.chip) return;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'dsh-imgblur-chip';
        chip.dataset.shown = entry.shown ? '1' : '0';
        // 小图用「只有眼睛」的紧凑按钮，不然一颗「显示」就把缩略图盖住一半。
        const small = (img.clientWidth || 0) < 140 || (img.clientHeight || 0) < 90;
        chip.dataset.compact = small ? '1' : '0';
        entry.compact = small;
        chip.title = t(entry.shown ? 'chip.blurTitle' : 'chip.showTitle');
        chip.setAttribute('aria-label', t(entry.shown ? 'chip.blurAria' : 'chip.showAria'));

        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 16 16');
        icon.setAttribute('width', '12');
        icon.setAttribute('height', '12');
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '1.4');
        icon.setAttribute('stroke-linecap', 'round');
        icon.setAttribute('stroke-linejoin', 'round');
        const eye = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        eye.setAttribute('d', 'M1.4 8S3.8 3.9 8 3.9 14.6 8 14.6 8 12.2 12.1 8 12.1 1.4 8 1.4 8Z');
        const pupil = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        pupil.setAttribute('cx', '8');
        pupil.setAttribute('cy', '8');
        pupil.setAttribute('r', '1.7');
        icon.appendChild(eye);
        icon.appendChild(pupil);

        const label = document.createElement('span');
        label.textContent = t(entry.shown ? 'chip.blur' : 'chip.show');

        chip.appendChild(icon);
        chip.appendChild(label);
        chip.addEventListener('pointerdown', (ev) => {
          ev.stopPropagation();
        });
        chip.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const live = this.tracked.get(img);
          this.setShown(img, !(live && live.shown));
        });

        entry.chip = chip;
        entry.label = label;
        this.layer.appendChild(chip);
        try {
          // chip 宽度量一次就缓存，滚动时每帧只读 img 矩形、不再触发重排。
          entry.width = chip.offsetWidth || 0;
        } catch (err) {
          entry.width = 0;
        }
      },

      setShown(img, shown) {
        const entry = this.tracked.get(img);
        const src = entry ? entry.src : img.currentSrc || img.src || '';
        if (shown) {
          this.revealed.set(src, true);
          if (this.revealed.size > 800) {
            const first = this.revealed.keys().next();
            if (!first.done) this.revealed.delete(first.value);
          }
        } else {
          this.revealed.delete(src);
        }
        this.tracked.forEach((other, el) => {
          if (other.src !== src) return;
          other.shown = shown;
          try {
            el.setAttribute(ATTR, shown ? 'shown' : 'hidden');
          } catch (err) {
            /* ignore */
          }
          if (other.chip) {
            other.chip.dataset.shown = shown ? '1' : '0';
            other.chip.title = t(shown ? 'chip.blurTitle' : 'chip.showTitle');
            other.chip.setAttribute('aria-label', t(shown ? 'chip.blurAria' : 'chip.showAria'));
          }
          if (other.label) other.label.textContent = t(shown ? 'chip.blur' : 'chip.show');
          if (other.chip) {
            try {
              other.width = other.chip.offsetWidth || 0;
            } catch (err) {
              /* ignore */
            }
          }
        });
      },

      // 设置变了：全部拆掉重新来（关掉开关时这一步就是「原样还原」）。
      refresh() {
        Array.from(this.tracked.keys()).forEach((img) => this.drop(img));
        this.scan();
        this.kick();
      },

      kick() {
        if (this.rafId) return;
        if (!this.tracked.size) return;
        this.rafId = requestAnimationFrame(() => {
          this.rafId = 0;
          if (!this.tracked.size) return;
          this.layout();
          this.kick();
        });
      },

      layout() {
        const layer = this.layer;
        if (!layer || typeof layer.getBoundingClientRect !== 'function') return;
        const lr = layer.getBoundingClientRect();
        const vw = window.innerWidth || 0;
        const vh = window.innerHeight || 0;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        // 同一帧里多个 chip 常常共用同一个滚动容器：它的矩形只量一次。
        const clipRects = new Map();
        function rectOf(el) {
          let r = clipRects.get(el);
          if (!r) {
            r = el.getBoundingClientRect();
            clipRects.set(el, r);
          }
          return r;
        }
        // 先读完所有 img 的矩形（以及把每张图裁到「真正可见的那块」），再统一写 transform：
        // 读写分开，滚动时不会因为「读-写-读-写」反复触发重排。
        const reads = [];
        const dead = [];
        this.tracked.forEach((entry, img) => {
          if (!img || !img.isConnected) {
            dead.push(img);
            return;
          }
          const chip = entry.chip;
          if (!chip) return;
          const r = img.getBoundingClientRect();
          // 裁切祖先可能是登记之后才出现的（用户消息从本地回显变成正式消息、
          // 卡片先画骨架再套滚动容器），所以为空时每秒补扫一次。
          if (!entry.clippers || !entry.clippers.length) {
            if (!entry.clipAt || now - entry.clipAt > 1000) {
              entry.clippers = this.clippersFor(img);
              entry.clipAt = now;
            }
          }
          let top = Math.max(r.top, 0);
          let bottom = Math.min(r.bottom, vh);
          let left = Math.max(r.left, 0);
          let right = Math.min(r.right, vw);
          const clippers = entry.clippers || [];
          for (let i = 0; i < clippers.length; i += 1) {
            const c = clippers[i];
            if (!c || !c.isConnected) continue;
            const cr = rectOf(c);
            if (cr.top > top) top = cr.top;
            if (cr.bottom < bottom) bottom = cr.bottom;
            if (cr.left > left) left = cr.left;
            if (cr.right < right) right = cr.right;
          }
          // 兜底命中测试：拿图片右上角内侧一个点（避开 chip 自己的盒子）做
          // elementFromPoint。只要那个点被裁掉 / 被别的层盖住，命中的就不是这张图
          // 或它所在的那层包装，于是按钮一起收起 —— 不依赖「猜哪些祖先是裁剪容器」。
          let hit = false;
          const px = r.right - 4;
          const py = r.top + 40;
          if (px > 0 && px < vw && py > 0 && py < vh) {
            let el = null;
            try {
              el = document.elementFromPoint(px, py);
            } catch (err) {
              el = null;
            }
            // 图片本身、图里的节点、或它往上 3 层包装里命中的元素都算「还看得见」
            // （缩略图常给 <img> 挂 pointer-events:none，命中会是包住它的那层）。
            let box = img.parentElement;
            for (let i = 0; box && i < 3 && !hit; i += 1) {
              hit = el === box || (box.contains ? box.contains(el) : false);
              box = box.parentElement;
            }
            if (!hit && el === img) hit = true;
          }
          reads.push({
            entry: entry,
            chip: chip,
            r: r,
            top: top,
            bottom: bottom,
            left: left,
            right: right,
            hit: hit,
          });
        });
        for (const item of reads) {
          const r = item.r;
          const chip = item.chip;
          // 可见区太小（图几乎滚没了 / 被折叠）就不画
          if (item.right - item.left < 26 || item.bottom - item.top < 20) {
            chip.style.display = 'none';
            continue;
          }
          // 图片那个角已经被裁掉 / 盖住：按钮跟着消失，不留在对话框外面。
          if (!item.hit) {
            chip.style.display = 'none';
            continue;
          }
          const w = item.entry.width || 58;
          const x = Math.min(Math.max(r.right - w - 8, 4), Math.max(vw - w - 4, 4));
          const y = Math.min(Math.max(r.top + 8, 4), Math.max(vh - 32, 4));
          // chip 还必须完整落在「图片可见区 ∩ 窗口」里。
          const inside =
            x >= item.left - 1 &&
            x + w <= item.right + 1 &&
            y >= item.top - 1 &&
            y + 24 <= item.bottom + 1;
          if (!inside) {
            chip.style.display = 'none';
            continue;
          }
          chip.style.display = '';
          chip.style.transform =
            'translate3d(' + Math.round(x - lr.left) + 'px,' + Math.round(y - lr.top) + 'px,0)';
        }
        dead.forEach((img) => this.drop(img));
      },

      queueScan() {
        if (this.scanTimer) return;
        this.scanTimer = setTimeout(() => {
          this.scanTimer = 0;
          try {
            this.scan();
            this.layout();
          } catch (err) {
            /* 一帧失败不影响后续 */
          }
          this.kick();
        }, 60);
      },

      attachLayer(layer) {
        this.layer = layer;
        // 浮层可能在引擎启动之后才挂载：给已经登记的图片重做 chip。
        this.tracked.forEach((entry, img) => {
          if (entry.chip) {
            try {
              entry.chip.remove();
            } catch (err) {
              /* ignore */
            }
          }
          entry.chip = null;
          entry.label = null;
          this.ensureChip(img, entry);
        });
        this.queueScan();
        this.kick();
        return () => {
          if (this.layer === layer) this.layer = null;
          this.tracked.forEach((entry) => {
            if (entry.chip) {
              try {
                entry.chip.remove();
              } catch (err) {
                /* ignore */
              }
            }
            entry.chip = null;
            entry.label = null;
          });
        };
      },
    };

    // ── 全局事件（都挂在 document 的捕获阶段，先于宿主自己的处理）───────────
    const swallow = new WeakMap();

    function imageFrom(ev) {
      const target = ev && ev.target;
      const el = target && target.nodeType === 1 ? target : target && target.parentElement;
      if (!el || typeof el.closest !== 'function') return null;
      return el.closest('img');
    }

    function blurredFrom(ev) {
      const img = imageFrom(ev);
      if (!img || !engine.tracked.has(img)) return null;
      return img.getAttribute(ATTR) === 'hidden' ? img : null;
    }

    function onDocPointerDown(ev) {
      const img = blurredFrom(ev);
      if (!img) return;
      // 按下就揭开，并且不把这次按下交给宿主（否则会同时弹看图层）。
      swallow.set(img, typeof performance !== 'undefined' ? performance.now() : Date.now());
      engine.setShown(img, true);
      ev.stopPropagation();
    }

    function onDocClick(ev) {
      const img = imageFrom(ev);
      if (!img) return;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const stamp = swallow.get(img);
      if (stamp && now - stamp < 600) {
        swallow.delete(img);
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      const blurred = blurredFrom(ev);
      if (blurred) {
        ev.preventDefault();
        ev.stopPropagation();
        engine.setShown(blurred, true);
      }
    }

    function onDocPointerOver(ev) {
      const img = imageFrom(ev);
      if (!img) return;
      const entry = engine.tracked.get(img);
      if (entry && entry.chip) entry.chip.dataset.hot = '1';
    }

    function onDocPointerOut(ev) {
      const img = imageFrom(ev);
      if (!img) return;
      const entry = engine.tracked.get(img);
      if (entry && entry.chip) delete entry.chip.dataset.hot;
    }

    function onDocLoad(ev) {
      const target = ev && ev.target;
      if (!target || target.tagName !== 'IMG') return;
      engine.queueScan();
    }

    // ── 槽位组件 ───────────────────────────────────────────────────────────
    // 锚点必须用 layout effect 登记：它同步跑在 commit 之后、绘制之前，
    // 于是 MutationObserver 回调（微任务，也早于绘制）里已经能算出作用域，
    // 新会话的第一帧就是糊的。用普通 useEffect 会晚一帧，正是「先露一下再糊」。
    const useIsoLayoutEffect = React.useLayoutEffect || useEffect;

    // 零尺寸锚点：只用来「定位会话正文容器」，不画任何东西、不占任何空间。
    function useAnchor(bucket) {
      const ref = useRef(null);
      useIsoLayoutEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        bucket.add(el);
        resetScope();
        engine.queueScan();
        return () => {
          bucket.delete(el);
          resetScope();
          engine.queueScan();
        };
      }, []);
      return h('span', { ref, className: 'dsh-imgblur-anchor', 'aria-hidden': 'true' });
    }

    function DockAnchor() {
      return useAnchor(anchors.dock);
    }

    function FlowAnchor() {
      return useAnchor(anchors.flow);
    }

    function BlurLayer() {
      const ref = useRef(null);
      useIsoLayoutEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        return engine.attachLayer(el);
      }, []);
      return h('div', { ref, className: 'dsh-imgblur-layer' });
    }

    function StrengthSegment() {
      return h(
        'div',
        { className: 'dsh-imgblur-seg', role: 'group', 'aria-label': t('settings.strength') },
        h('span', { className: 'dsh-imgblur-seg-label' }, t('settings.strength')),
        STRENGTH_KEYS.map((key) =>
          h(
            'button',
            {
              key,
              type: 'button',
              className: 'dsh-imgblur-seg-btn' + (settings.strength === key ? ' is-on' : ''),
              'aria-pressed': settings.strength === key ? 'true' : 'false',
              disabled: !settings.enabled,
              onClick: () => applySettings({ strength: key }),
            },
            t(key === 'light' ? 'strengthLight' : key === 'normal' ? 'strengthNormal' : 'strengthStrong'),
          ),
        ),
      );
    }

    function SettingsRow() {
      const [, bump] = useState(0);
      useEffect(() => {
        const fn = () => bump((n) => (n + 1) % 1000000);
        subs.add(fn);
        return () => {
          subs.delete(fn);
        };
      }, []);
      const on = settings.enabled;
      return h(
        'div',
        { className: 'dsh-imgblur-row' },
        h(
          'div',
          { className: 'dsh-imgblur-col' },
          h('div', { className: 'dsh-imgblur-name' }, t('settings.title')),
          h('div', { className: 'dsh-imgblur-desc' }, t(on ? 'settings.desc' : 'settings.offDesc')),
        ),
        h(
          'div',
          { className: 'dsh-imgblur-ctrls' },
          h(StrengthSegment, null),
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              'aria-checked': on ? 'true' : 'false',
              'aria-label': t('settings.title'),
              className: 'dsh-imgblur-switch' + (on ? ' is-on' : ''),
              onClick: () => applySettings({ enabled: !on }),
            },
            h('span', { className: 'dsh-imgblur-knob' }),
          ),
        ),
      );
    }

    // ── 插件本体 ───────────────────────────────────────────────────────────
    return {
      inject: ['slots'],
      apply(ctx) {
        localeCtx = ctx;
        // 语言包：注册成功就用 locale 服务，注册不上（老宿主）就用本机字典。
        try {
          const loc = ctx.get ? ctx.get('locale') : null;
          if (loc && typeof loc.register === 'function') {
            ['zh-CN', 'zh', 'en-US', 'en'].forEach((id) => {
              ctx.effect(() => {
                try {
                  return loc.register(NS, id, TEXT[id.indexOf('zh') === 0 ? 'zh' : 'en']);
                } catch (err) {
                  return () => {};
                }
              }, 'image-blur-locale-' + id);
            });
            if (typeof loc.bind === 'function') translate = loc.bind(NS);
          }
        } catch (err) {
          translate = null;
        }

        // 引擎常驻：CSS + 观察者只装一次（apply 万一被调两次也不会重复）。
        try {
          engine.start();
        } catch (err) {
          /* 引擎起不来也不能让整个 Client 半边炸掉 */
        }

        ctx.effect(() => {
          try {
            // 注意：必须包一层，直接返回 engine.stop 会丢 this。
            return () => engine.stop();
          } catch (err) {
            return () => {};
          }
        }, 'image-blur-engine');

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'image-blur-pills', order: 30 }, BlurLayer),
        );
        // 作用域锚点：一个落在消息流里，一个落在输入框下方，二者公共祖先 = 会话正文。
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'image-blur-anchor-flow', order: 990 }, FlowAnchor),
        );
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'image-blur-anchor-dock', order: 990 }, DockAnchor),
        );
        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register({ name: 'settings.general.item', id: 'image-blur', order: 21 }, SettingsRow),
        );
      },
    };
  },
});
