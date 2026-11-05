(function () {
  'use strict';

  /** Replace ⭐️ N/10 with a colored badge in h2, h3, and li elements */
  function processScoreBadges() {
    var scoreRe = /⭐️\s*(\d+(?:\.\d+)?)\/10/;
    var targets = document.querySelectorAll('.main-content h2, .main-content h3, .main-content li');
    targets.forEach(function (el) {
      var m = el.innerHTML.match(scoreRe);
      if (!m) return;
      var score = parseFloat(m[1]);
      var tier;
      if (score >= 9) tier = 'high';
      else if (score >= 7) tier = 'good';
      else if (score >= 5) tier = 'mid';
      else tier = 'low';
      el.innerHTML = el.innerHTML.replace(
        scoreRe,
        '<span class="score-badge" data-tier="' + tier + '">' + m[1] + '</span>'
      );
    });
  }

  /** Add semantic classes to tag lines, source lines, and background paragraphs */
  function markSemanticElements() {
    var paragraphs = document.querySelectorAll('.main-content p');
    paragraphs.forEach(function (p) {
      var text = p.textContent.trim();

      // Tag line: starts with Tags or 标签 (bold prefix rendered by Markdown)
      if (/^(Tags|标签|Теги)\s*:/.test(text)) {
        p.classList.add('tag-line');
        return;
      }

      // Source line: pattern like "source · site · date"
      if (/^(rss|reddit|github|hackernews|hn|telegram)\s*·/i.test(text)) {
        p.classList.add('source-line');
        return;
      }
    });
  }

  function setupLanguageToggle() {
    var languages = [
      { code: 'ru', label: 'RU' },
      { code: 'zh', label: '中文' },
      { code: 'en', label: 'EN' }
    ];

    var toggle = document.createElement('div');
    toggle.className = 'lang-toggle';

    var buttons = {};
    var sections = {};
    languages.forEach(function (language) {
      var button = document.createElement('button');
      button.textContent = language.label;
      button.type = 'button';
      toggle.appendChild(button);
      buttons[language.code] = button;
      sections[language.code] = document.getElementById('lang-' + language.code);
    });

    document.body.insertBefore(toggle, document.body.firstChild);

    var saved = null;
    try { saved = localStorage.getItem('horizon-lang'); } catch (e) {}
    var currentLang = buttons[saved] ? saved : 'ru';
    var isIndexPage = languages.some(function (language) { return sections[language.code]; });

    function updateButtons(lang) {
      languages.forEach(function (language) {
        buttons[language.code].classList.toggle('active', language.code === lang);
      });
    }

    function showSection(lang) {
      languages.forEach(function (language) {
        var section = sections[language.code];
        if (section) section.classList.toggle('hidden', language.code !== lang);
      });
    }

    function switchArticleLang(lang) {
      var path = window.location.pathname;
      var suffix = /-(en|zh|ru)(\.html|\/)?$/;
      var match = path.match(suffix);
      if (!match || match[1] === lang) return;
      window.location.href = path.replace(suffix, '-' + lang + (match[2] || ''));
    }

    function setLang(lang) {
      currentLang = lang;
      updateButtons(lang);
      try { localStorage.setItem('horizon-lang', lang); } catch (e) {}
      if (isIndexPage) {
        showSection(lang);
      } else {
        switchArticleLang(lang);
      }
    }

    languages.forEach(function (language) {
      buttons[language.code].addEventListener('click', function () { setLang(language.code); });
    });

    updateButtons(currentLang);
    if (isIndexPage) {
      showSection(currentLang);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    processScoreBadges();
    markSemanticElements();
    setupLanguageToggle();
  });
})();
