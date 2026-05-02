/* ═══════════════════════════════════════════════════════════════════════
   AURUM CENTURY CLUB — SHARED JS MODULE
   Import on every gated page. No external dependencies.
   ═══════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ─── Language ────────────────────────────────────────────────────── */
  function setLang(l) {
    localStorage.setItem('au_lang', l);
    var base = document.body.className.replace(/\blang-\w+/g, '').trim();
    document.body.className = (base ? base + ' ' : '') + 'lang-' + l;
    document.documentElement.lang = l;
    global._lang = l;
  }

  (function () { setLang(localStorage.getItem('au_lang') || 'ko'); }());

  global.setLang = setLang;
  global._lang = localStorage.getItem('au_lang') || 'ko';

  global.TACC = global.TACC || {};
  global.TACC.setLang = setLang;

  /* ─── Page veil transitions ───────────────────────────────────────── */
  var veil = document.getElementById('page-veil');

  function attachTransitions() {
    document.querySelectorAll('a[href]').forEach(function (link) {
      var href = link.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('http') ||
          href.startsWith('mailto') || href.startsWith('tel') ||
          link.dataset.noTransition !== undefined) return;
      link.addEventListener('click', function (e) {
        e.preventDefault();
        if (veil) veil.classList.add('covering');
        setTimeout(function () { window.location.href = href; }, 220);
      });
    });
  }

  /* ─── Page entrance animation ─────────────────────────────────────── */
  function runPageEntrance() {
    document.body.style.opacity = '0';
    document.body.style.transform = 'translateY(8px)';
    document.body.style.transition = 'opacity 350ms var(--ease-entrance), transform 350ms var(--ease-entrance)';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        document.body.style.opacity = '1';
        document.body.style.transform = 'translateY(0)';
      });
    });
  }

  /* ─── Scroll reveals ──────────────────────────────────────────────── */
  function initScrollReveals() {
    var els = document.querySelectorAll('[data-reveal]');
    if (!els.length) return;
    if ('IntersectionObserver' in window) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('revealed');
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.12, rootMargin: '-60px 0px 0px 0px' });
      els.forEach(function (el) { observer.observe(el); });
    } else {
      els.forEach(function (el) { el.classList.add('revealed'); });
    }
  }

  /* ─── KPI countup ─────────────────────────────────────────────────── */
  // Ease-out-quart
  function easeOutQuart(p) { return 1 - Math.pow(1 - p, 4); }

  function countUp(el, target, duration, prefix, suffix, decimals) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = (prefix || '') + target.toFixed(decimals || 0) + (suffix || '');
      return;
    }
    var start = performance.now();
    var from = parseFloat(el.dataset.countFrom || 0);
    decimals = decimals !== undefined ? decimals : 0;
    function tick(now) {
      var elapsed = now - start;
      var progress = Math.min(elapsed / duration, 1);
      var eased = easeOutQuart(progress);
      var current = from + (target - from) * eased;
      el.textContent = (prefix || '') + current.toFixed(decimals) + (suffix || '');
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  global.TACC.countUp = countUp;

  /* ─── Gold price flash ────────────────────────────────────────────── */
  var _lastSpotPrice = null;
  function flashGoldPrice(el, newPrice) {
    if (_lastSpotPrice !== null && newPrice !== _lastSpotPrice) {
      var up = newPrice > _lastSpotPrice;
      el.style.color = up ? 'var(--green)' : 'var(--red)';
      el.style.transition = 'color 1800ms ease';
      setTimeout(function () { el.style.color = ''; }, 1800);
      var arrow = document.createElement('span');
      arrow.textContent = up ? ' ↑' : ' ↓';
      arrow.style.cssText = 'font-size:0.75em;opacity:1;transition:opacity 3s ease;';
      el.appendChild(arrow);
      setTimeout(function () { arrow.style.opacity = '0'; }, 200);
      setTimeout(function () { if (arrow.parentNode) arrow.parentNode.removeChild(arrow); }, 3300);
    }
    _lastSpotPrice = newPrice;
  }
  global.TACC.flashGoldPrice = flashGoldPrice;

  /* ─── Tap-to-copy ─────────────────────────────────────────────────── */
  function initCopyHandlers() {
    document.querySelectorAll('[data-copy]').forEach(function (el) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', function () {
        var val = el.getAttribute('data-copy');
        navigator.clipboard.writeText(val).then(function () {
          var tip = document.createElement('span');
          tip.textContent = 'Copied';
          tip.style.cssText = [
            'position:absolute',
            'background:var(--surface)',
            'border:1px solid var(--goldBorderS)',
            'color:var(--goldA)',
            'font-family:var(--font-mono)',
            'font-size:10px',
            'letter-spacing:0.14em',
            'padding:4px 10px',
            'pointer-events:none',
            'z-index:1000',
            'transform:translateY(-120%)',
            'white-space:nowrap'
          ].join(';');
          el.style.position = 'relative';
          el.appendChild(tip);
          setTimeout(function () { if (tip.parentNode) tip.parentNode.removeChild(tip); }, 1500);
        }).catch(function () {});
      });
    });
  }
  global.TACC.initCopyHandlers = initCopyHandlers;

  /* ─── KRW formatter ───────────────────────────────────────────────── */
  function fmKrw(n) {
    if (!n || isNaN(n)) return '—';
    var v = parseFloat(n);
    if (v >= 1e8) return '₩' + (v / 1e8).toFixed(1) + '억';
    if (v >= 1e4) return '₩' + Math.round(v / 1e4).toLocaleString() + '만';
    return '₩' + Math.round(v).toLocaleString();
  }
  global.TACC.fmKrw = fmKrw;

  /* ─── Date formatter ──────────────────────────────────────────────── */
  function fmDate(ts, lang) {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  global.TACC.fmDate = fmDate;

  /* ─── bindData utility ────────────────────────────────────────────── */
  function bindData(data) {
    document.querySelectorAll('[data-bind]').forEach(function (el) {
      var key = el.getAttribute('data-bind');
      var keys = key.split('.');
      var val = data;
      for (var i = 0; i < keys.length; i++) {
        if (val == null) break;
        val = val[keys[i]];
      }
      if (val !== undefined && val !== null) {
        el.textContent = val;
      }
    });
  }
  global.TACC.bindData = bindData;

  /* ─── Skeleton shimmer ────────────────────────────────────────────── */
  function showSkeletons() {
    document.querySelectorAll('[data-skeleton]').forEach(function (el) {
      el.classList.add('skeleton-active');
    });
  }
  function hideSkeletons() {
    document.querySelectorAll('[data-skeleton]').forEach(function (el) {
      el.classList.remove('skeleton-active');
    });
  }
  global.TACC.showSkeletons = showSkeletons;
  global.TACC.hideSkeletons = hideSkeletons;

  /* ─── Document.hidden animation pause ────────────────────────────── */
  document.addEventListener('visibilitychange', function () {
    if (typeof global.TACC._onVisibilityChange === 'function') {
      global.TACC._onVisibilityChange(!document.hidden);
    }
  });

  /* ─── Mobile platform detection ───────────────────────────────────── */
  global.TACC.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  global.TACC.isAndroid = /Android/.test(navigator.userAgent);

  /* ─── Init on DOMContentLoaded ────────────────────────────────────── */
  function init() {
    runPageEntrance();
    attachTransitions();
    initScrollReveals();
    initCopyHandlers();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

}(window));
