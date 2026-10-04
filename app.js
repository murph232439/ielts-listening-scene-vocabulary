(() => {
  "use strict";

  const DATA = window.SCENE_DATA;
  const app = document.getElementById("app");
  const audioElement = document.getElementById("sceneAudio");
  const toastElement = document.getElementById("toast");
  const wrongCountElement = document.getElementById("navWrongCount");

  const STORAGE_KEYS = {
    wrong: "ielts-scene-vocab-wrong-v1",
    study: "ielts-scene-vocab-study-v1",
  };
  const SPELL_SECONDS = 15;
  const CHOICE_SECONDS = 10;

  const SCENE_COLORS = ["#12736f", "#b85235", "#356f9d", "#b47a1d"];

  let homeSearch = "";
  let studyState = null;
  let dictationState = null;
  let phaseFrame = null;
  let feedbackTimer = null;
  let toastTimer = null;
  const audioBundlePromises = new Map();
  const audioObjectUrls = new Map();
  const sceneSearchCache = new Map();

  const sceneById = new Map(DATA.scenes.map((scene) => [scene.id, scene]));
  const wordIndex = new Map();
  for (const scene of DATA.scenes) {
    for (const word of scene.words) {
      wordIndex.set(`${scene.id}:${word.id}`, { scene, word });
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalizeAnswer(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replaceAll("’", "'")
      .replace(/[.,!?;:]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function shuffle(items) {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
    }
    return result;
  }

  function readStorage(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      showToast("浏览器未允许本地保存");
    }
  }

  function readWrongBank() {
    return readStorage(STORAGE_KEYS.wrong, {});
  }

  function writeWrongBank(bank) {
    writeStorage(STORAGE_KEYS.wrong, bank);
    updateWrongCount();
  }

  function updateWrongCount() {
    const count = Object.keys(readWrongBank()).length;
    wrongCountElement.textContent = String(count);
    wrongCountElement.hidden = count === 0;
  }

  function readStudyProgress() {
    return readStorage(STORAGE_KEYS.study, {});
  }

  function saveStudyCompletion(sceneId, completedIds) {
    const progress = readStudyProgress();
    progress[sceneId] = [...completedIds];
    writeStorage(STORAGE_KEYS.study, progress);
  }

  function getStudyCompletion(sceneId) {
    const progress = readStudyProgress();
    return new Set(progress[sceneId] || []);
  }

  function addWrong(scene, word) {
    const bank = readWrongBank();
    const existing = bank[word.id];
    bank[word.id] = {
      id: word.id,
      sceneId: scene.id,
      english: word.english,
      chinese: word.chinese,
      category: word.category,
      wrongCount: (existing?.wrongCount || 0) + 1,
      streak: 0,
      lastWrongAt: Date.now(),
    };
    writeWrongBank(bank);
  }

  function recordCorrect(scene, word) {
    const bank = readWrongBank();
    const existing = bank[word.id];
    if (!existing) {
      return;
    }
    existing.streak = (existing.streak || 0) + 1;
    if (existing.streak >= 2) {
      delete bank[word.id];
      showToast("已连续答对两次，移出错词库");
    } else {
      existing.lastWrongAt = Date.now();
      bank[word.id] = existing;
    }
    writeWrongBank(bank);
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    toastElement.textContent = message;
    toastElement.classList.add("show");
    toastTimer = window.setTimeout(() => {
      toastElement.classList.remove("show");
    }, 2200);
  }

  function refreshIcons() {
    if (window.lucide) {
      window.lucide.createIcons({
        attrs: {
          "aria-hidden": "true",
        },
      });
    }
  }

  function route() {
    const raw = window.location.hash.replace(/^#/, "") || "home";
    const parts = raw.split("/");
    return {
      name: parts[0] || "home",
      id: parts.slice(1).join("/") || "",
    };
  }

  function goTo(path) {
    const nextHash = `#${path}`;
    if (window.location.hash === nextHash) {
      renderRoute();
    } else {
      window.location.hash = nextHash;
    }
  }

  function setActiveNav(name) {
    document.querySelectorAll("[data-nav]").forEach((element) => {
      element.classList.toggle("active", element.dataset.nav === name);
    });
  }

  function stopAudio() {
    audioElement.pause();
    audioElement.playbackRate = 1;
    audioElement.volume = 1;
  }

  function clearDictationTimers() {
    if (phaseFrame) {
      window.cancelAnimationFrame(phaseFrame);
      phaseFrame = null;
    }
    if (feedbackTimer) {
      window.clearTimeout(feedbackTimer);
      feedbackTimer = null;
    }
  }

  function destroyView() {
    stopAudio();
    clearDictationTimers();
  }

  function playFileClip(audioPath, rate = 1) {
    if (!audioPath) {
      return false;
    }
    stopAudio();
    audioElement.src = new URL(audioPath, window.location.href).href;
    audioElement.load();
    audioElement.playbackRate = rate;
    audioElement.volume = 1;
    audioElement.play().catch(() => {
      showToast("点击播放按钮后可播放录音");
    });
    return true;
  }

  function playEncodedClip(encoded, cacheKey, rate = 1) {
    if (!encoded) {
      return false;
    }
    let objectUrl = audioObjectUrls.get(cacheKey);
    if (!objectUrl) {
      try {
        const binary = window.atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        objectUrl = URL.createObjectURL(
          new Blob([bytes], { type: "audio/mpeg" }),
        );
        audioObjectUrls.set(cacheKey, objectUrl);
      } catch {
        showToast("音频数据读取失败");
        return false;
      }
    }

    stopAudio();
    audioElement.src = objectUrl;
    audioElement.load();
    audioElement.currentTime = 0;
    audioElement.playbackRate = rate;
    audioElement.volume = 1;
    audioElement.play().catch(() => {
      showToast("点击播放按钮后可播放录音");
    });
    return true;
  }

  function loadAudioBundle(sceneId) {
    if (window.VOCAB_AUDIO_BUNDLES?.[sceneId]) {
      return Promise.resolve();
    }
    if (audioBundlePromises.has(sceneId)) {
      return audioBundlePromises.get(sceneId);
    }
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL(
        `audio/bundles/${sceneId}.js`,
        window.location.href,
      ).href;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("audio bundle failed"));
      document.head.appendChild(script);
    }).catch((error) => {
      audioBundlePromises.delete(sceneId);
      throw error;
    });
    audioBundlePromises.set(sceneId, promise);
    return promise;
  }

  function preloadSceneAudio(words) {
    if (window.location.protocol === "file:") {
      return;
    }
    const bundleIds = new Set(
      words
        .map((word) => word.audioBundle)
        .filter(Boolean),
    );
    bundleIds.forEach((sceneId) => {
      loadAudioBundle(sceneId).catch(() => {});
    });
  }

  function playEnglish(scene, word, rate = 1) {
    if (window.location.protocol === "file:" && word.audioPath) {
      playFileClip(word.audioPath, rate);
      return;
    }
    if (!word.audioBundle || !word.audioKey) {
      showToast("该词原录音未覆盖，暂不可播放");
      return;
    }
    const play = () => {
      const encoded = window.VOCAB_AUDIO_BUNDLES?.[word.audioBundle]?.[
        word.audioKey
      ];
      if (!encoded) {
        showToast("该词原录音未覆盖，暂不可播放");
        return;
      }
      playEncodedClip(
        encoded,
        `${word.audioBundle}:${word.audioKey}`,
        rate,
      );
    };
    const bundle = window.VOCAB_AUDIO_BUNDLES?.[word.audioBundle];
    if (bundle) {
      play();
      return;
    }
    showToast("正在加载原声");
    loadAudioBundle(word.audioBundle).then(play).catch(() => {
      showToast("原声加载失败，请重新点击");
    });
  }

  function sceneColor(index) {
    return SCENE_COLORS[index % SCENE_COLORS.length];
  }

  function sceneCardMarkup(scene, index) {
    const audioCount =
      scene.audioCount ??
      scene.words.filter((word) => Boolean(word.audio)).length;
    const audioLabel = scene.supplement
      ? audioCount
        ? `原声 ${audioCount}/${scene.words.length}`
        : "暂无可播放原声"
      : "原录音";
    const dictationDisabled = audioCount === 0;

    return `
      <article
        class="scene-card ${scene.supplement ? "supplement-card" : ""}"
        style="--scene-color:${sceneColor(index)}"
        data-scene-card
        data-scene-id="${escapeHtml(scene.id)}"
      >
        <div class="scene-card-body">
          <div class="scene-topline">
            <span class="scene-index">${String(index + 1).padStart(2, "0")}</span>
            <span class="audio-badge ${audioCount ? "" : "speech"}">
              <i data-lucide="${audioCount ? "audio-lines" : "volume-x"}"></i>
              ${audioLabel}
            </span>
          </div>
          <h2>${escapeHtml(scene.title)}</h2>
          <p class="scene-subtitle">${escapeHtml(scene.subtitle)}</p>
          <p class="scene-count">${scene.words.length} 个词条</p>
          <div class="scene-actions">
            <button
              class="btn btn-primary"
              type="button"
              data-action="navigate"
              data-route="study/${scene.id}"
            >
              <i data-lucide="headphones"></i>
              学习
            </button>
            <button
              class="btn btn-secondary"
              type="button"
              data-action="navigate"
              data-route="dictation/${scene.id}"
              ${dictationDisabled ? "disabled" : ""}
              ${dictationDisabled ? 'title="本场景暂无可播放原声"' : ""}
            >
              <i data-lucide="keyboard"></i>
              听写
            </button>
          </div>
        </div>
      </article>
    `;
  }

  function searchTextForScene(scene) {
    if (!sceneSearchCache.has(scene.id)) {
      sceneSearchCache.set(
        scene.id,
        [
          scene.title,
          scene.subtitle,
          ...scene.words.map(
            (word) =>
              `${word.english} ${word.chinese} ${word.definition || ""} ${word.example || ""}`,
          ),
        ]
          .join(" ")
          .toLowerCase(),
      );
    }
    return sceneSearchCache.get(scene.id);
  }

  function renderHome() {
    const query = homeSearch.trim().toLowerCase();
    const originalScenes = DATA.scenes.filter((scene) => !scene.supplement);
    const supplementScenes = DATA.scenes.filter((scene) => scene.supplement);
    const matches = (scene) => {
      if (!query) {
        return true;
      }
      return searchTextForScene(scene).includes(query);
    };
    const originalCards = originalScenes
      .filter(matches)
      .map(sceneCardMarkup)
      .join("");
    const supplementCards = supplementScenes
      .filter(matches)
      .map(sceneCardMarkup)
      .join("");
    const noResults = !originalCards && !supplementCards;

    app.innerHTML = `
      <section class="hero">
        <div>
          <p class="eyebrow">IELTS Listening Vocabulary</p>
          <h1>雅思听力场景词汇</h1>
          <p class="hero-copy">原声逐词训练，加课程词汇补充；错词自动进入复练库。</p>
        </div>
        <div class="summary-strip" aria-label="练习统计">
          <div class="summary-item">
            <strong>${DATA.originalSceneCount}</strong>
            <span>原声场景</span>
          </div>
          <div class="summary-item">
            <strong>${DATA.supplementSceneCount}</strong>
            <span>补充场景</span>
          </div>
          <div class="summary-item">
            <strong>${DATA.wordCount}</strong>
            <span>总词条</span>
          </div>
        </div>
      </section>

      <div class="toolbar">
        <label class="search-field">
          <i data-lucide="search"></i>
          <input
            id="sceneSearch"
            type="search"
            value="${escapeHtml(homeSearch)}"
            placeholder="搜索场景、英文、中文或释义"
            autocomplete="off"
          >
        </label>
      </div>

      ${originalCards ? `
        <div class="section-heading">
          <div>
            <h2>原声训练</h2>
            <p>只播放原录音中的英文词条切片。</p>
          </div>
          <span>${originalScenes.length} 个场景</span>
        </div>
        <section class="scene-grid">${originalCards}</section>
      ` : ""}

      ${supplementCards ? `
        <div class="section-heading">
          <div>
            <h2>课程补充</h2>
            <p>含音标、词性、释义、变形和例句；有原声的词可直接播放。</p>
          </div>
          <span>${supplementScenes.length} 个场景</span>
        </div>
        <section class="scene-grid">${supplementCards}</section>
      ` : ""}

      ${noResults ? `
        <div class="empty-state">
          <div>
            <div class="empty-state-icon"><i data-lucide="search-x"></i></div>
            <h2>没有匹配场景</h2>
            <p>换一个英文单词、中文释义或场景名称。</p>
          </div>
        </div>
      ` : ""}
    `;
    setActiveNav("home");
    refreshIcons();
  }

  function renderStudy() {
    const scene = sceneById.get(studyState.sceneId);
    if (!scene) {
      goTo("home");
      return;
    }
    const word = scene.words[studyState.index];
    const completedCount = scene.words.filter((item) =>
      studyState.completed.has(item.id),
    ).length;
    const isDone = studyState.checked && studyState.correct;
    const isWrong = studyState.checked && !studyState.correct;
    const detailMeta = [word.partOfSpeech, word.phonetic]
      .filter(Boolean)
      .join(" · ");
    const prompt = !word.audio
      ? `
        <div class="study-prompt">
          ${detailMeta ? `<span class="detail-meta">${escapeHtml(detailMeta)}</span>` : ""}
          <strong>${escapeHtml(word.chinese)}</strong>
          ${word.definition ? `<p>${escapeHtml(word.definition)}</p>` : ""}
        </div>
      `
      : "";
    const feedback = studyState.checked
      ? `
        <div class="study-feedback ${isDone ? "correct" : "wrong"}">
          <p class="feedback-title ${isDone ? "correct" : "wrong"}">
            <i data-lucide="${isDone ? "circle-check" : "circle-x"}"></i>
            ${isDone ? "拼写正确" : "需要复练"}
          </p>
          <p class="feedback-answer">${escapeHtml(word.english)}</p>
          ${detailMeta ? `<p class="feedback-meta">${escapeHtml(detailMeta)}</p>` : ""}
          <p class="feedback-meaning">${escapeHtml(word.chinese)}</p>
          ${word.definition ? `<p class="feedback-extra">${escapeHtml(word.definition)}</p>` : ""}
          ${word.forms ? `<p class="feedback-extra">变形：${escapeHtml(word.forms)}</p>` : ""}
          ${word.example ? `<p class="feedback-example">${escapeHtml(word.example)}</p>` : ""}
        </div>
      `
      : `
        <div class="study-feedback">
          <p class="feedback-title">
            <i data-lucide="ear"></i>
            听音后输入完整拼写
          </p>
          <p class="feedback-meaning">按 Enter 或点击检查。</p>
        </div>
      `;

    const list = scene.words
      .map((item, index) => {
        const active = index === studyState.index;
        const done = studyState.completed.has(item.id);
        return `
          <button
            class="word-jump ${active ? "active" : ""}"
            type="button"
            data-action="study-jump"
            data-index="${index}"
          >
            <span class="word-number">${index + 1}</span>
            <span class="word-meta">
              <strong>${escapeHtml(item.english)}</strong>
              <span>${escapeHtml(item.chinese)}</span>
            </span>
            <span class="word-state ${done ? "done" : ""}">
              <i data-lucide="${done ? "check" : "volume-2"}"></i>
            </span>
          </button>
        `;
      })
      .join("");

    app.innerHTML = `
      <div class="view-heading">
        <button class="back-button" type="button" data-action="navigate" data-route="home" aria-label="返回场景">
          <i data-lucide="arrow-left"></i>
        </button>
        <div class="view-heading-copy">
          <h1>${escapeHtml(scene.title)} · 学习</h1>
          <p class="view-subtitle">${escapeHtml(scene.subtitle)} · ${scene.words.length} 个词条</p>
        </div>
      </div>

      <div class="study-layout">
        <section class="trainer-panel">
          <div class="panel-topline">
            <span class="progress-copy">已完成 ${completedCount} / ${scene.words.length}</span>
            <span class="category-tag">${escapeHtml(word.category)}</span>
          </div>
          <div class="progress-track" aria-hidden="true">
            <span style="width:${(completedCount / scene.words.length) * 100}%"></span>
          </div>
          ${prompt}

          <div class="audio-console">
            <button
              class="audio-main-button"
              type="button"
              data-action="study-play"
              ${word.audio ? "" : "disabled"}
              aria-label="播放当前单词"
            >
              <i data-lucide="volume-2"></i>
            </button>
            <div class="audio-options">
              ${word.audio ? `
                <label>
                  速度
                  <select data-role="study-rate">
                    <option value="0.75">0.75×</option>
                    <option value="1" selected>1.0×</option>
                  </select>
                </label>
                <button class="btn btn-secondary" type="button" data-action="study-replay">
                  <i data-lucide="rotate-ccw"></i>
                  再听
                </button>
              ` : `<span class="muted">该词原录音未覆盖</span>`}
            </div>
          </div>

          <form class="spell-form" data-role="study-form">
            <input
              class="answer-input"
              id="studyAnswer"
              type="text"
              value="${studyState.checked ? escapeHtml(studyState.answer) : ""}"
              placeholder="输入英文拼写"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              aria-label="英文拼写"
            >
            <button class="btn btn-primary" type="submit">
              <i data-lucide="check"></i>
              检查
            </button>
          </form>

          ${feedback}

          <div class="trainer-nav">
            <button class="btn btn-secondary" type="button" data-action="study-prev">
              <i data-lucide="chevron-left"></i>
              上一个
            </button>
            <button class="btn btn-primary" type="button" data-action="study-next">
              下一个
              <i data-lucide="chevron-right"></i>
            </button>
          </div>
        </section>

        <aside class="word-list-panel">
          <div class="word-list-header">
            <h2>本场景词表</h2>
            <span class="muted">${scene.words.length} 词</span>
          </div>
          <div class="word-list">${list}</div>
        </aside>
      </div>
    `;
    setActiveNav("home");
    refreshIcons();
    preloadSceneAudio(scene.words);
    const input = document.getElementById("studyAnswer");
    if (!studyState.checked && input) {
      input.focus();
    }
  }

  function buildOptions(scene, word) {
    const meanings = [
      ...new Set(
        scene.words
          .map((item) => item.chinese)
          .filter((meaning) => meaning !== word.chinese),
      ),
    ];
    const distractors = shuffle(meanings).slice(0, 3);
    return shuffle([word.chinese, ...distractors]);
  }

  function currentDictationWord() {
    if (!dictationState || !dictationState.queue.length) {
      return null;
    }
    return dictationState.queue[dictationState.index] || null;
  }

  function renderDictationHeader() {
    const current = currentDictationWord();
    const title =
      dictationState.kind === "wrong"
        ? "错词听写"
        : `${dictationState.scene.title} · 听写`;
    const total = dictationState.queue.length;
    const currentNumber = Math.min(dictationState.index + 1, total);
    return `
      <div class="view-heading">
        <button
          class="back-button"
          type="button"
          data-action="navigate"
          data-route="${dictationState.kind === "wrong" ? "wrong" : "home"}"
          aria-label="返回"
        >
          <i data-lucide="arrow-left"></i>
        </button>
        <div class="view-heading-copy">
          <h1>${escapeHtml(title)}</h1>
          <p class="view-subtitle">
            ${current ? `第 ${currentNumber} / ${total} 词` : `${total} 个词条`}
          </p>
        </div>
      </div>
    `;
  }

  function renderDictation() {
    if (!dictationState || dictationState.queue.length === 0) {
      renderEmptyDictation();
      return;
    }

    if (dictationState.phase === "done") {
      renderDictationSummary();
      return;
    }

    const current = currentDictationWord();
    const scene = current.scene;
    const word = current.word;
    const total = dictationState.queue.length;
    const progress = ((dictationState.index + 1) / total) * 100;
    let content = "";

    if (dictationState.phase === "spell") {
      content = `
        <div class="dictation-phase">
          <div class="phase-content">
            <div class="countdown-ring" aria-label="听写倒计时">
              <svg viewBox="0 0 136 136" aria-hidden="true">
                <circle class="countdown-base" cx="68" cy="68" r="60"></circle>
                <circle
                  class="countdown-value"
                  id="countdownCircle"
                  cx="68"
                  cy="68"
                  r="60"
                ></circle>
              </svg>
              <span class="countdown-number" id="countdownNumber">${SPELL_SECONDS}</span>
            </div>
            <h2 class="phase-title">听音拼写</h2>
            <p class="phase-note">倒计时结束后进入中文选择</p>
            <input
              class="dictation-spell-input"
              id="dictationAnswer"
              type="text"
              value="${escapeHtml(dictationState.spellValue)}"
              placeholder="输入英文"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              aria-label="英文拼写"
            >
          </div>
        </div>
      `;
    } else if (dictationState.phase === "meaning") {
      content = `
        <div class="dictation-phase">
          <div class="phase-content">
            <div class="countdown-ring" aria-label="选择倒计时">
              <svg viewBox="0 0 136 136" aria-hidden="true">
                <circle class="countdown-base" cx="68" cy="68" r="60"></circle>
                <circle
                  class="countdown-value"
                  id="countdownCircle"
                  cx="68"
                  cy="68"
                  r="60"
                ></circle>
              </svg>
              <span class="countdown-number" id="countdownNumber">${CHOICE_SECONDS}</span>
            </div>
            <h2 class="phase-title">选择中文意思</h2>
            <p class="phase-note">
              你的拼写：${dictationState.spellValue.trim() ? escapeHtml(dictationState.spellValue) : "未填写"}
            </p>
            <div class="options-grid">
              ${dictationState.options
                .map(
                  (option) => `
                    <button
                      class="option-button"
                      type="button"
                      data-action="dictation-option"
                      data-option="${escapeHtml(option)}"
                    >
                      ${escapeHtml(option)}
                    </button>
                  `,
                )
                .join("")}
            </div>
          </div>
        </div>
      `;
    } else if (dictationState.phase === "feedback") {
      const result = dictationState.results.at(-1);
      content = `
        <div class="dictation-feedback">
          <div>
            <div class="feedback-icon ${result.correct ? "correct" : "wrong"}">
              <i data-lucide="${result.correct ? "circle-check" : "circle-x"}"></i>
            </div>
            <h2>${result.correct ? "正确" : "已加入错词库"}</h2>
            <p><strong>${escapeHtml(word.english)}</strong></p>
            <p>${escapeHtml(word.chinese)}</p>
          </div>
        </div>
      `;
    }

    app.innerHTML = `
      ${renderDictationHeader()}
      <section class="dictation-panel">
        <div class="dictation-kicker">
          <span>${escapeHtml(word.category)}</span>
          <span>${dictationState.index + 1} / ${total}</span>
        </div>
        <div class="progress-track" aria-hidden="true">
          <span style="width:${progress}%"></span>
        </div>
        ${content}
      </section>
    `;
    setActiveNav(dictationState.kind === "wrong" ? "wrong" : "home");
    refreshIcons();
    preloadSceneAudio(
      dictationState.kind === "wrong"
        ? dictationState.queue.map((item) => item.word)
        : dictationState.scene.words,
    );

    if (dictationState.phase === "spell") {
      const input = document.getElementById("dictationAnswer");
      input?.focus();
      setCountdownAppearance(SPELL_SECONDS);
      schedulePhase(SPELL_SECONDS, finishSpellPhase, updateCountdown);
    } else if (dictationState.phase === "meaning") {
      setCountdownAppearance(CHOICE_SECONDS);
      schedulePhase(CHOICE_SECONDS, () => finishMeaningPhase(null), updateCountdown);
    }
  }

  function renderEmptyDictation() {
    app.innerHTML = `
      ${renderDictationHeader()}
      <div class="empty-state">
        <div>
          <div class="empty-state-icon"><i data-lucide="notebook-tabs"></i></div>
          <h2>错词库为空</h2>
          <p>完成一次听写后，答错或未拼出的词会出现在这里。</p>
          <button class="btn btn-primary" type="button" data-action="navigate" data-route="home">
            <i data-lucide="arrow-left"></i>
            返回场景
          </button>
        </div>
      </div>
    `;
    refreshIcons();
  }

  function renderDictationSummary() {
    const wrongResults = dictationState.results.filter((result) => !result.correct);
    const correctCount = dictationState.results.length - wrongResults.length;
    app.innerHTML = `
      ${renderDictationHeader()}
      <section class="session-summary">
        <div class="summary-score">
          <div class="score-circle">${correctCount}/${dictationState.results.length}</div>
          <div>
            <h2>本轮完成</h2>
            <p>${wrongResults.length ? `${wrongResults.length} 个词已进入错词库` : "本轮全部正确"}</p>
          </div>
        </div>

        ${wrongResults.length ? `
          <div class="result-list">
            ${wrongResults
              .map(
                (result) => `
                  <div class="result-row">
                    <div>
                      <strong>${escapeHtml(result.word.english)}</strong>
                      <span>${escapeHtml(result.word.chinese)}</span>
                    </div>
                    <span class="result-mark">待复练</span>
                  </div>
                `,
              )
              .join("")}
          </div>
        ` : ""}

        <div class="summary-actions">
          <button class="btn btn-primary" type="button" data-action="dictation-restart">
            <i data-lucide="refresh-cw"></i>
            重练本轮
          </button>
          <button class="btn btn-secondary" type="button" data-action="wrong-dictation">
            <i data-lucide="notebook-tabs"></i>
            复习错词
          </button>
          <button class="btn btn-secondary" type="button" data-action="navigate" data-route="home">
            <i data-lucide="layout-grid"></i>
            返回场景
          </button>
        </div>
      </section>
    `;
    setActiveNav(dictationState.kind === "wrong" ? "wrong" : "home");
    refreshIcons();
  }

  function setCountdownAppearance(seconds) {
    const circle = document.getElementById("countdownCircle");
    if (!circle) {
      return;
    }
    const circumference = 2 * Math.PI * 60;
    circle.style.strokeDasharray = String(circumference);
    circle.style.strokeDashoffset = "0";
    const number = document.getElementById("countdownNumber");
    if (number) {
      number.textContent = String(seconds);
    }
  }

  function updateCountdown(timeLeft, seconds) {
    const circle = document.getElementById("countdownCircle");
    const number = document.getElementById("countdownNumber");
    if (circle) {
      const circumference = 2 * Math.PI * 60;
      const elapsedRatio = 1 - timeLeft / seconds;
      circle.style.strokeDashoffset = String(circumference * elapsedRatio);
    }
    if (number) {
      number.textContent = String(Math.max(0, Math.ceil(timeLeft)));
    }
  }

  function schedulePhase(seconds, onDone, onTick) {
    if (phaseFrame) {
      window.cancelAnimationFrame(phaseFrame);
    }
    const startedAt = performance.now();
    const tick = (now) => {
      const elapsed = (now - startedAt) / 1000;
      const timeLeft = Math.max(0, seconds - elapsed);
      onTick(timeLeft, seconds);
      if (timeLeft <= 0) {
        phaseFrame = null;
        onDone();
        return;
      }
      phaseFrame = window.requestAnimationFrame(tick);
    };
    phaseFrame = window.requestAnimationFrame(tick);
  }

  function beginSpellPhase() {
    clearDictationTimers();
    const current = currentDictationWord();
    if (!current) {
      dictationState.phase = "done";
      renderDictation();
      return;
    }
    dictationState.phase = "spell";
    dictationState.spellValue = "";
    dictationState.options = buildOptions(current.scene, current.word);
    renderDictation();
    playEnglish(current.scene, current.word, 1);
  }

  function finishSpellPhase() {
    if (!dictationState || dictationState.phase !== "spell") {
      return;
    }
    clearDictationTimers();
    const current = currentDictationWord();
    dictationState.spellingCorrect =
      normalizeAnswer(dictationState.spellValue) ===
      normalizeAnswer(current.word.english);
    dictationState.phase = "meaning";
    renderDictation();
  }

  function finishMeaningPhase(selectedOption) {
    if (!dictationState || dictationState.phase !== "meaning") {
      return;
    }
    clearDictationTimers();
    const current = currentDictationWord();
    const correct =
      dictationState.spellingCorrect &&
      selectedOption === current.word.chinese;
    if (correct) {
      recordCorrect(current.scene, current.word);
    } else {
      addWrong(current.scene, current.word);
    }
    dictationState.results.push({
      ...current,
      spelling: dictationState.spellValue,
      selectedOption,
      correct,
    });
    dictationState.phase = "feedback";
    renderDictation();
    feedbackTimer = window.setTimeout(() => {
      if (!dictationState || dictationState.phase !== "feedback") {
        return;
      }
      dictationState.index += 1;
      if (dictationState.index >= dictationState.queue.length) {
        dictationState.phase = "done";
        stopAudio();
        renderDictation();
      } else {
        beginSpellPhase();
      }
    }, 850);
  }

  function buildDictationQueue(scene) {
    return shuffle(scene.words.filter((word) => word.audio)).map((word) => ({
      scene,
      word,
    }));
  }

  function buildWrongQueue() {
    return Object.values(readWrongBank())
      .map((item) => {
        const scene = sceneById.get(item.sceneId);
        const word = scene?.words.find((candidate) => candidate.id === item.id);
        return scene && word ? { scene, word } : null;
      })
      .filter(Boolean);
  }

  function startDictation(scene) {
    dictationState = {
      kind: "scene",
      scene,
      queue: buildDictationQueue(scene),
      index: 0,
      phase: "spell",
      spellValue: "",
      spellingCorrect: false,
      options: [],
      results: [],
    };
    renderDictation();
    beginSpellPhase();
  }

  function startWrongDictation() {
    const queue = shuffle(buildWrongQueue());
    dictationState = {
      kind: "wrong",
      scene: null,
      queue,
      index: 0,
      phase: "spell",
      spellValue: "",
      spellingCorrect: false,
      options: [],
      results: [],
    };
    renderDictation();
    if (queue.length) {
      beginSpellPhase();
    }
  }

  function renderWrongBank() {
    const bank = readWrongBank();
    const items = Object.values(bank).sort((left, right) => {
      if (left.sceneId !== right.sceneId) {
        return left.sceneId.localeCompare(right.sceneId);
      }
      return right.wrongCount - left.wrongCount;
    });
    const sceneCount = new Set(items.map((item) => item.sceneId)).size;
    const attempts = items.reduce((total, item) => total + item.wrongCount, 0);

    if (!items.length) {
      app.innerHTML = `
        <div class="view-heading">
          <button class="back-button" type="button" data-action="navigate" data-route="home" aria-label="返回场景">
            <i data-lucide="arrow-left"></i>
          </button>
          <div class="view-heading-copy">
            <h1>错词库</h1>
            <p class="view-subtitle">答错或未拼出的词会保留在这里。</p>
          </div>
        </div>
        <div class="empty-state">
          <div>
            <div class="empty-state-icon"><i data-lucide="notebook-tabs"></i></div>
            <h2>还没有错词</h2>
            <p>进入任意场景听写，系统会自动收集需要反复练习的词。</p>
            <button class="btn btn-primary" type="button" data-action="navigate" data-route="home">
              <i data-lucide="layout-grid"></i>
              选择场景
            </button>
          </div>
        </div>
      `;
      setActiveNav("wrong");
      refreshIcons();
      return;
    }

    const grouped = new Map();
    for (const item of items) {
      if (!grouped.has(item.sceneId)) {
        grouped.set(item.sceneId, []);
      }
      grouped.get(item.sceneId).push(item);
    }

    const groups = [...grouped.entries()]
      .map(([sceneId, groupItems]) => {
        const scene = sceneById.get(sceneId);
        return `
          <section class="wrong-group">
            <h2>${escapeHtml(scene?.title || "其他场景")}</h2>
            ${groupItems
              .map(
                (item) => `
                  <div class="wrong-word">
                    <div>
                      <strong>${escapeHtml(item.english)}</strong>
                      <span>${escapeHtml(item.chinese)}</span>
                    </div>
                    <span class="wrong-word-meta">
                      错 ${item.wrongCount} 次 · 连续正确 ${item.streak || 0}/2
                    </span>
                    <button
                      class="icon-button btn btn-quiet"
                      type="button"
                      data-action="wrong-play"
                      data-id="${escapeHtml(item.id)}"
                      aria-label="播放 ${escapeHtml(item.english)}"
                    >
                      <i data-lucide="volume-2"></i>
                    </button>
                    <button
                      class="icon-button btn btn-quiet"
                      type="button"
                      data-action="wrong-delete"
                      data-id="${escapeHtml(item.id)}"
                      aria-label="移除 ${escapeHtml(item.english)}"
                    >
                      <i data-lucide="x"></i>
                    </button>
                  </div>
                `,
              )
              .join("")}
          </section>
        `;
      })
      .join("");

    app.innerHTML = `
      <div class="view-heading">
        <button class="back-button" type="button" data-action="navigate" data-route="home" aria-label="返回场景">
          <i data-lucide="arrow-left"></i>
        </button>
        <div class="view-heading-copy">
          <h1>错词库</h1>
          <p class="view-subtitle">连续答对两次后，单词会自动移出。</p>
        </div>
      </div>

      <section class="wrong-summary">
        <div class="wrong-stat">
          <strong>${items.length}</strong>
          <span>待复练词条</span>
        </div>
        <div class="wrong-stat">
          <strong>${sceneCount}</strong>
          <span>涉及场景</span>
        </div>
        <div class="wrong-stat">
          <strong>${attempts}</strong>
          <span>累计错误次数</span>
        </div>
      </section>

      <div class="wrong-toolbar">
        <button class="btn btn-primary" type="button" data-action="wrong-dictation">
          <i data-lucide="keyboard"></i>
          错词听写
        </button>
        <button class="btn btn-danger" type="button" data-action="clear-wrong">
          <i data-lucide="trash-2"></i>
          清空错词
        </button>
      </div>

      <div class="wrong-list-panel">${groups}</div>
    `;
    setActiveNav("wrong");
    refreshIcons();
  }

  function renderRoute() {
    destroyView();
    const currentRoute = route();
    window.scrollTo({ top: 0, behavior: "instant" });

    if (currentRoute.name === "study") {
      const scene = sceneById.get(currentRoute.id);
      if (!scene) {
        goTo("home");
        return;
      }
      const completed = getStudyCompletion(scene.id);
      const firstIncomplete = scene.words.findIndex(
        (word) => !completed.has(word.id),
      );
      studyState = {
        sceneId: scene.id,
        index: firstIncomplete >= 0 ? firstIncomplete : 0,
        checked: false,
        correct: false,
        answer: "",
        completed,
      };
      renderStudy();
      return;
    }

    if (currentRoute.name === "dictation") {
      if (currentRoute.id === "wrong-bank") {
        startWrongDictation();
      } else {
        const scene = sceneById.get(currentRoute.id);
        if (!scene) {
          goTo("home");
          return;
        }
        startDictation(scene);
      }
      return;
    }

    if (currentRoute.name === "wrong") {
      renderWrongBank();
      return;
    }

    renderHome();
  }

  function handleStudySubmit() {
    if (!studyState || studyState.checked) {
      return;
    }
    const scene = sceneById.get(studyState.sceneId);
    const word = scene.words[studyState.index];
    const input = document.getElementById("studyAnswer");
    const answer = input?.value || "";
    const correct = normalizeAnswer(answer) === normalizeAnswer(word.english);
    studyState.checked = true;
    studyState.correct = correct;
    studyState.answer = answer;
    if (correct) {
      studyState.completed.add(word.id);
      saveStudyCompletion(scene.id, studyState.completed);
      recordCorrect(scene, word);
    } else {
      addWrong(scene, word);
    }
    renderStudy();
  }

  function moveStudy(offset) {
    if (!studyState) {
      return;
    }
    const scene = sceneById.get(studyState.sceneId);
    studyState.index =
      (studyState.index + offset + scene.words.length) % scene.words.length;
    studyState.checked = false;
    studyState.correct = false;
    studyState.answer = "";
    renderStudy();
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) {
      return;
    }
    const action = target.dataset.action;

    if (action === "navigate") {
      goTo(target.dataset.route);
      return;
    }

    if (action === "study-play" || action === "study-replay") {
      const scene = sceneById.get(studyState.sceneId);
      const word = scene.words[studyState.index];
      const rate = Number(
        document.querySelector("[data-role='study-rate']")?.value || 1,
      );
      playEnglish(scene, word, rate);
      return;
    }

    if (action === "study-prev") {
      moveStudy(-1);
      return;
    }

    if (action === "study-next") {
      moveStudy(1);
      return;
    }

    if (action === "study-jump") {
      studyState.index = Number(target.dataset.index);
      studyState.checked = false;
      studyState.correct = false;
      studyState.answer = "";
      renderStudy();
      return;
    }

    if (action === "dictation-option") {
      finishMeaningPhase(target.dataset.option);
      return;
    }

    if (action === "dictation-restart") {
      if (dictationState.kind === "wrong") {
        startWrongDictation();
      } else {
        startDictation(dictationState.scene);
      }
      return;
    }

    if (action === "wrong-dictation") {
      goTo("dictation/wrong-bank");
      return;
    }

    if (action === "wrong-play") {
      const entry = readWrongBank()[target.dataset.id];
      if (!entry) {
        return;
      }
      const scene = sceneById.get(entry.sceneId);
      const word = scene?.words.find((candidate) => candidate.id === entry.id);
      if (scene && word) {
        playEnglish(scene, word, 1);
      }
      return;
    }

    if (action === "wrong-delete") {
      const bank = readWrongBank();
      delete bank[target.dataset.id];
      writeWrongBank(bank);
      renderWrongBank();
      return;
    }

    if (action === "clear-wrong") {
      if (window.confirm("清空全部错词？")) {
        writeWrongBank({});
        renderWrongBank();
      }
    }
  });

  document.addEventListener("submit", (event) => {
    if (event.target.matches("[data-role='study-form']")) {
      event.preventDefault();
      handleStudySubmit();
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "sceneSearch") {
      homeSearch = event.target.value;
      const query = homeSearch.trim().toLowerCase();
      document.querySelectorAll("[data-scene-card]").forEach((card) => {
        const scene = sceneById.get(card.dataset.sceneId);
        card.hidden =
          query && scene && !searchTextForScene(scene).includes(query);
      });
      return;
    }

    if (event.target.id === "dictationAnswer" && dictationState) {
      dictationState.spellValue = event.target.value;
    }
  });

  document.addEventListener("keydown", (event) => {
    if (
      event.target.id === "dictationAnswer" &&
      event.key === "Enter" &&
      dictationState?.phase === "spell"
    ) {
      event.preventDefault();
      finishSpellPhase();
    }
  });

  window.addEventListener("hashchange", renderRoute);
  updateWrongCount();
  renderRoute();
})();
