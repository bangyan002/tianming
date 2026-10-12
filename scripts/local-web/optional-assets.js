/* Local web: skip missing assets while keeping every available file. */
(function (root) {
  'use strict';
  const inventory = root.TM_LOCAL_ASSETS;
  if (!inventory || !Array.isArray(inventory.paths)) return;
  const available = new Set(inventory.paths);
  // Missing images must still fail decoding so existing onerror fallbacks run.
  // A transparent valid image would wrongly activate artwork-only menu layouts.
  const blank = 'data:image/png;base64,';
  function missing(value) {
    try {
      const url = new URL(String(value), document.baseURI);
      const path = decodeURIComponent(url.pathname);
      return url.origin === location.origin && /(?:^|\/)assets\//i.test(path) && !available.has(path);
    } catch (_) { return false; }
  }
  function css(value) {
    return String(value).replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi,
      (match, quote, url) => missing(url) ? 'none' : match);
  }
  function srcset(value) {
    const candidates = String(value).split(',');
    const kept = candidates.filter(item => !missing(item.trim().split(/\s+/)[0]));
    return kept.length === candidates.length ? value : kept.length ? kept.join(',') : blank;
  }
  function markup(value) {
    return css(value).replace(/\b(src|poster|srcset)\s*=\s*(['"])(.*?)\2/gi,
      (match, name, quote, url) => {
        const filtered = name.toLowerCase() === 'srcset' ? srcset(url) : missing(url) ? blank : url;
        return filtered !== url ? name + '=' + quote + filtered + quote : match;
      });
  }
  function setter(proto, name, filter) {
    let descriptor;
    while (proto && !(descriptor = Object.getOwnPropertyDescriptor(proto, name))) proto = Object.getPrototypeOf(proto);
    if (!descriptor || !descriptor.set || !descriptor.configurable) return;
    Object.defineProperty(proto, name, Object.assign({}, descriptor, {
      set(value) { descriptor.set.call(this, filter.call(this, value)); }
    }));
  }
  setter(HTMLImageElement.prototype, 'src', value => missing(value) ? blank : value);
  setter(HTMLImageElement.prototype, 'srcset', srcset);
  setter(HTMLVideoElement.prototype, 'poster', value => missing(value) ? blank : value);
  setter(HTMLMediaElement.prototype, 'src', value => missing(value) ? '' : value);
  setter(HTMLSourceElement.prototype, 'src', value => missing(value) ? '' : value);
  setter(HTMLSourceElement.prototype, 'srcset', srcset);
  setter(Element.prototype, 'innerHTML', markup);
  const insertHTML = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function (position, value) {
    return insertHTML.call(this, position, markup(value));
  };
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    const key = String(name).toLowerCase();
    if (key === 'style') value = css(value);
    else if (['src', 'poster'].includes(key) && missing(value)) {
      if (['AUDIO', 'VIDEO', 'SOURCE'].includes(this.tagName) && key === 'src') {
        this.removeAttribute(name); return;
      }
      value = blank;
    } else if (key === 'srcset') value = srcset(value);
    return setAttribute.call(this, name, value);
  };
  // Named CSS properties are browser-owned instance properties, so filter writes
  // through element.style as well as setProperty and cssText.
  const styles = new WeakMap();
  for (const proto of [HTMLElement.prototype, SVGElement.prototype]) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'style');
    if (!descriptor || !descriptor.get || !descriptor.configurable) continue;
    Object.defineProperty(proto, 'style', Object.assign({}, descriptor, {
      get() {
        const style = descriptor.get.call(this);
        if (!styles.has(style)) styles.set(style, new Proxy(style, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' && key !== 'constructor' ? value.bind(target) : value;
          },
          set(target, key, value) { return Reflect.set(target, key, css(value), target); }
        }));
        return styles.get(style);
      },
      set(value) { descriptor.set.call(this, css(value)); }
    }));
  }
  setter(CSSStyleDeclaration.prototype, 'cssText', css);
  const setProperty = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
    return setProperty.call(this, name, css(value), priority);
  };
  setter(Node.prototype, 'textContent', function (value) {
    return this.nodeName === 'STYLE' ? css(value) : value;
  });
  const insertRule = CSSStyleSheet.prototype.insertRule;
  CSSStyleSheet.prototype.insertRule = function (rule, index) {
    return insertRule.call(this, css(rule), index);
  };
  const Audio = root.Audio;
  root.Audio = function (src) { return new Audio(missing(src) ? undefined : src); };
  root.Audio.prototype = Audio.prototype;
  const fetch = root.fetch;
  root.fetch = function (input, init) {
    if (missing(input instanceof Request ? input.url : input)) {
      return Promise.resolve(new Response(null, { status: 404, statusText: 'Asset not found' }));
    }
    return fetch.call(this, input, init);
  };
  root.TM_LOCAL_ASSETS_FILTERED = true;
})(window);
