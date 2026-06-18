/* tunlite — shared behaviour for the landing page and the docs page.
   Pre-paint language selection lives inline in each page's <head>; this file
   wires up the interactive bits once the DOM is ready. */
(function () {
  var root = document.documentElement;

  /* ---- language toggle (persists across pages on the same origin) ---- */
  function setLang(lang) {
    root.dataset.lang = lang;
    root.lang = lang === 'zh' ? 'zh-Hans' : 'en';
    try { localStorage.setItem('tunlite-lang', lang); } catch (e) {}
    document.querySelectorAll('[data-set-lang]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.setLang === lang));
    });
  }
  document.querySelectorAll('[data-set-lang]').forEach(function (b) {
    b.addEventListener('click', function () { setLang(b.dataset.setLang); });
  });
  setLang(root.dataset.lang === 'zh' ? 'zh' : 'en');

  /* ---- install tabs (npx / curl / PowerShell) ---- */
  var tabs = document.querySelectorAll('.tab');
  var panels = document.querySelectorAll('[data-panel]');
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t) { t.setAttribute('aria-selected', String(t === tab)); });
      panels.forEach(function (p) { p.hidden = p.dataset.panel !== tab.dataset.tab; });
    });
  });

  /* ---- copy buttons ---- */
  document.querySelectorAll('.copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var code = btn.parentElement.querySelector('code').textContent;
      var done = function () {
        var en = root.dataset.lang !== 'zh';
        var prev = btn.textContent;
        btn.textContent = en ? 'copied' : '已复制';
        btn.classList.add('done');
        setTimeout(function () { btn.textContent = 'copy'; btn.classList.remove('done'); }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(done, done);
      } else {
        var ta = document.createElement('textarea');
        ta.value = code; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta); done();
      }
    });
  });

  /* ---- scroll reveal ---- */
  var reveal = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window && reveal.length) {
    var ro = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); ro.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    reveal.forEach(function (el) { ro.observe(el); });
  } else {
    reveal.forEach(function (el) { el.classList.add('in'); });
  }

  /* ---- footer version: always reflect the latest published npm release ---- */
  var ver = document.getElementById('ver');
  if (ver && window.fetch) {
    fetch('https://registry.npmjs.org/tunlite/latest')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.version) ver.textContent = 'v' + d.version; })
      .catch(function () {});
  }

  /* ---- docs sidebar: scroll-spy + mobile collapse ---- */
  var sidebar = document.querySelector('.sidebar');
  if (sidebar) {
    var links = Array.prototype.slice.call(sidebar.querySelectorAll('a[href^="#"]'));
    var byId = {};
    links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    var sections = links
      .map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); })
      .filter(Boolean);

    var current = null;
    function setActive(id) {
      if (id === current) return;
      current = id;
      links.forEach(function (a) { a.classList.toggle('active', a.getAttribute('href').slice(1) === id); });
    }

    if ('IntersectionObserver' in window && sections.length) {
      var visible = {};
      var so = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { visible[e.target.id] = e.isIntersecting ? e.intersectionRatio : 0; });
        // pick the top-most section that is currently on screen
        var best = null, bestTop = Infinity;
        sections.forEach(function (s) {
          if (visible[s.id]) {
            var top = s.getBoundingClientRect().top;
            if (top < bestTop) { bestTop = top; best = s.id; }
          }
        });
        if (best) setActive(best);
      }, { rootMargin: '-20% 0px -70% 0px', threshold: [0, 0.25, 0.5, 1] });
      sections.forEach(function (s) { so.observe(s); });
    }

    // mobile collapse
    var toggle = sidebar.querySelector('.sb-toggle');
    if (toggle) {
      toggle.addEventListener('click', function () { sidebar.classList.toggle('open'); });
      sidebar.querySelectorAll('.sb-inner a').forEach(function (a) {
        a.addEventListener('click', function () { sidebar.classList.remove('open'); });
      });
    }
  }
})();
