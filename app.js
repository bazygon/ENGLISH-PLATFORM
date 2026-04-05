const STORAGE_KEY = 'english-b2-master-state-v1';
const questions = window.B2_DATA.questions;
const questionMap = new Map(questions.map((q) => [q.id, q]));

let appState = loadState();
let activePlacement = null;
let activeExam = null;
let practiceFilter = 'Wszystkie';
let practiceQuestionId = null;
let examTimerHandle = null;
let flashcardIndex = 0;
const flashcards = window.B2_DATA.flashcards || [];

function loadState() {
  const fallbackSkills = ['Grammar', 'Vocabulary', 'Tłumaczenie', 'Transformacje zdań', 'Reading'];
  const defaults = {
    attempted: 0,
    correct: 0,
    streak: 0,
    bestStreak: 0,
    skillStats: Object.fromEntries(fallbackSkills.map((s) => [s, { attempted: 0, correct: 0 }])),
    history: [],
    recentAnswers: [],
    mistakes: [],
    startedAt: new Date().toISOString(),
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      ...defaults,
      ...parsed,
      skillStats: { ...defaults.skillStats, ...(parsed.skillStats || {}) },
      history: parsed.history || [],
      recentAnswers: parsed.recentAnswers || [],
      mistakes: parsed.mistakes || [],
    };
  } catch {
    return defaults;
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
}

function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function accuracy(attempted, correct) {
  return attempted ? Math.round((correct / attempted) * 100) : 0;
}

function getQuestionSkill(question) {
  return question.skill;
}

function recordAnswer(question, isCorrect, userAnswer, meta = {}) {
  appState.attempted += 1;
  if (isCorrect) {
    appState.correct += 1;
    appState.streak += 1;
    appState.bestStreak = Math.max(appState.bestStreak, appState.streak);
  } else {
    appState.streak = 0;
  }

  const skill = getQuestionSkill(question);
  if (!appState.skillStats[skill]) {
    appState.skillStats[skill] = { attempted: 0, correct: 0 };
  }
  appState.skillStats[skill].attempted += 1;
  if (isCorrect) appState.skillStats[skill].correct += 1;

  const answerEntry = {
    id: crypto.randomUUID(),
    questionId: question.id,
    correct: isCorrect,
    userAnswer,
    timestamp: new Date().toISOString(),
    mode: meta.mode || 'practice',
  };

  appState.recentAnswers.unshift(answerEntry);
  appState.recentAnswers = appState.recentAnswers.slice(0, 80);

  if (!isCorrect) {
    appState.mistakes.unshift({
      ...answerEntry,
      prompt: question.prompt,
      sampleAnswer: question.sampleAnswer || question.options?.[question.answer] || '',
      explanation: question.explanation,
      skill: question.skill,
      category: question.category,
    });
    appState.mistakes = dedupeByQuestion(appState.mistakes).slice(0, 60);
  }

  saveState();
}

function dedupeByQuestion(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.questionId)) return false;
    seen.add(item.questionId);
    return true;
  });
}

function buildStatCard(title, value, sub = '') {
  return `
    <article class="stat-card">
      <h4>${title}</h4>
      <div class="stat-value">${value}</div>
      <div class="stat-sub">${sub}</div>
    </article>
  `;
}

function setActiveView(view) {
  document.querySelectorAll('.nav-link').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });
  document.querySelectorAll('.view').forEach((section) => {
    const isActive = section.id === `view-${view}`;
    section.classList.toggle('active', isActive);
    if (isActive) {
      section.classList.remove('slide-up');
      void section.offsetWidth;
      section.classList.add('slide-up');
    }
  });
}

function initNavigation() {
  document.querySelectorAll('.nav-link').forEach((button) => {
    button.addEventListener('click', () => {
      setActiveView(button.dataset.view);
      renderAll();
    });
  });

  document.body.addEventListener('click', (event) => {
    const quick = event.target.closest('.quick-start');
    if (quick) {
      setActiveView(quick.dataset.target);
      renderAll();
    }
  });
}

function initControls() {
  document.getElementById('resetProgressBtn').addEventListener('click', () => {
    if (!confirm('Czy na pewno chcesz usunąć wszystkie zapisane postępy?')) return;
    localStorage.removeItem(STORAGE_KEY);
    appState = loadState();
    activePlacement = null;
    activeExam = null;
    practiceQuestionId = null;
    clearExamTimer();
    renderAll();
  });
}

function renderDashboard() {
  const root = document.getElementById('view-dashboard');
  const tpl = document.getElementById('hero-template');
  const hero = tpl.content.cloneNode(true);
  root.innerHTML = '';
  root.appendChild(hero);

  document.getElementById('heroStats').innerHTML = [
    buildStatCard('Baza pytań', window.B2_DATA.meta.questionCount, 'Ćwiczenia B2 w kilku formatach'),
    buildStatCard('Dokładność', `${accuracy(appState.attempted, appState.correct)}%`, 'Na podstawie wszystkich prób'),
    buildStatCard('Rozwiązane zadania', appState.attempted, 'Każda odpowiedź zapisuje się lokalnie'),
    buildStatCard('Bank błędów', appState.mistakes.length, 'Powtarzaj to, co sprawia problem'),
  ].join('');

  const recent = appState.history.slice(0, 4);
  const recentMarkup = recent.length
    ? recent.map((item) => `
        <div class="result-item">
          <h5>${item.title}</h5>
          <div class="result-meta">${formatDate(item.finishedAt)} · ${item.score}% · ${item.correct}/${item.total}</div>
        </div>
      `).join('')
    : `<div class="empty-state"><p>Nie masz jeszcze ukończonych testów. Zacznij od testu poziomującego albo trybu ćwiczeń.</p></div>`;

  const skills = Object.entries(appState.skillStats).map(([skill, stats]) => `
    <div class="kpi">
      <div class="kpi-label">${skill}</div>
      <div class="kpi-value">${accuracy(stats.attempted, stats.correct)}%</div>
      <div class="muted">${stats.correct}/${stats.attempted || 0} poprawnych</div>
    </div>
  `).join('');

  root.insertAdjacentHTML('beforeend', `
    <section class="dashboard-grid">
      <div class="panel">
        <h3>Moduły platformy</h3>
        <div class="modules-grid">
          ${buildModuleCard('Test poziomujący B2', '40 pytań dobranych tak, aby szybko sprawdzić, czy jesteś na poziomie B2 i gdzie masz luki.', 'placement')}
          ${buildModuleCard('Practice mode', 'Losowe ćwiczenia z gramatyki, słownictwa, tłumaczeń, readingu i transformacji zdań.', 'practice')}
          ${buildModuleCard('Symulator egzaminu', 'Pełniejszy miks zadań z limitem czasu i końcowym raportem wyniku.', 'exam')}
          ${buildModuleCard('Fiszki B2', 'Szybka powtórka słownictwa, idiomów i phrasal verbs za pomocą interaktywnych fiszek.', 'flashcards')}
          ${buildModuleCard('Powtórka błędów', 'Osobny moduł do analizy pytań, które wcześniej zrobiłeś źle.', 'mistakes')}
        </div>
      </div>
      <div class="panel">
        <h3>Twoje najmocniejsze i najsłabsze obszary</h3>
        <div class="kpi-row">${skills}</div>
      </div>
    </section>

    <section class="dashboard-grid" style="margin-top:16px;">
      <div class="panel">
        <h3>Jak pracować z tą platformą</h3>
        <ul class="list-clean">
          <li>Rozpocznij od testu poziomującego i sprawdź poziom wyjściowy.</li>
          <li>Potem ćwicz codziennie 15–25 zadań w Practice mode.</li>
          <li>Raz na kilka dni uruchamiaj symulator egzaminu na czas.</li>
          <li>Wracaj do zakładki „Powtórka błędów”, żeby zamieniać słabe punkty w mocne.</li>
        </ul>
      </div>
      <div class="panel">
        <h3>Ostatnie ukończone sesje</h3>
        <div class="result-list">${recentMarkup}</div>
      </div>
    </section>
  `);
}

function buildModuleCard(title, description, target) {
  return `
    <article class="module-card">
      <h4>${title}</h4>
      <p>${description}</p>
      <div class="tags">
        <span class="tag">B2</span>
        <span class="tag">interaktywnie</span>
        <span class="tag">wyniki i analiza</span>
      </div>
      <div class="module-footer">
        <button class="primary-btn quick-start" data-target="${target}">Otwórz moduł</button>
      </div>
    </article>
  `;
}

function renderPlacement() {
  const root = document.getElementById('view-placement');
  if (!activePlacement) {
    const latest = appState.history.find((h) => h.type === 'placement');
    root.innerHTML = `
      <div class="exam-grid">
        <aside class="panel">
          <h3>Test poziomujący B2</h3>
          <p>
            Ten moduł zawiera 40 zadań przekrojowych. Sprawdza gramatykę, słownictwo,
            reading oraz praktyczne użycie języka na poziomie B2.
          </p>
          <div class="tags">
            <span class="tag">40 pytań</span>
            <span class="tag">mieszany format</span>
            <span class="tag">natychmiastowy wynik</span>
          </div>
          <div class="card-actions">
            <button id="startPlacementBtn" class="primary-btn">Uruchom test poziomujący</button>
          </div>
          ${latest ? `<p class="muted">Ostatni wynik: <strong>${latest.score}%</strong> (${latest.correct}/${latest.total}) z dnia ${formatDate(latest.finishedAt)}.</p>` : ''}
        </aside>
        <section class="summary-card">
          <h4>Jak interpretować wynik</h4>
          <ul class="list-clean">
            <li>85–100%: bardzo mocny B2 / B2+</li>
            <li>70–84%: stabilny poziom B2</li>
            <li>55–69%: B1+ z potencjałem do wejścia na B2</li>
            <li>0–54%: warto najpierw domknąć podstawy B1/B1+</li>
          </ul>
          <p class="muted">Po zakończeniu dostaniesz krótką diagnozę i rekomendację dalszej pracy.</p>
        </section>
      </div>
    `;
    document.getElementById('startPlacementBtn').addEventListener('click', startPlacement);
    return;
  }

  renderSession(root, activePlacement, 'placement');
}

function startPlacement() {
  activePlacement = {
    type: 'placement',
    title: 'Test poziomujący B2',
    questionIds: [...window.B2_DATA.placementIds],
    index: 0,
    answers: [],
    startedAt: new Date().toISOString(),
  };
  renderPlacement();
}

function renderPractice() {
  const root = document.getElementById('view-practice');
  if (!practiceQuestionId) {
    practiceQuestionId = pickPracticeQuestion();
  }
  const question = questionMap.get(practiceQuestionId);
  const counts = window.B2_DATA.practiceModes.map((mode) => {
    const count = mode === 'Wszystkie'
      ? questions.length
      : questions.filter((q) => q.skill === mode).length;
    return `<button class="filter-chip ${practiceFilter === mode ? 'active' : ''}" data-filter="${mode}">${mode} <strong>${count}</strong></button>`;
  }).join('');

  root.innerHTML = `
    <section class="practice-grid">
      <aside class="panel">
        <h3>Practice mode</h3>
        <p>Ćwicz pojedyncze zadania z wybranego obszaru. To najlepszy tryb do codziennej nauki.</p>
        <div class="practice-filters">${counts}</div>
        <div class="card-actions" style="margin-top:16px;">
          <button id="newPracticeBtn" class="primary-btn">Nowe zadanie</button>
        </div>
        <p class="muted">Aktualny filtr: <strong>${practiceFilter}</strong></p>
      </aside>
      <div id="practiceQuestionWrap"></div>
    </section>
  `;

  root.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      practiceFilter = button.dataset.filter;
      practiceQuestionId = pickPracticeQuestion();
      renderPractice();
    });
  });

  document.getElementById('newPracticeBtn').addEventListener('click', () => {
    practiceQuestionId = pickPracticeQuestion(practiceQuestionId);
    renderPractice();
  });

  renderSingleQuestion(document.getElementById('practiceQuestionWrap'), question, {
    mode: 'practice',
    onNext: () => {
      practiceQuestionId = pickPracticeQuestion(practiceQuestionId);
      renderPractice();
      renderStats();
      renderDashboard();
      renderMistakes();
    },
  });
}

function pickPracticeQuestion(excludeId = null) {
  const pool = practiceFilter === 'Wszystkie'
    ? questions
    : questions.filter((q) => q.skill === practiceFilter);
  const filtered = pool.filter((q) => q.id !== excludeId);
  return shuffle(filtered).at(0)?.id || questions[0].id;
}

function startExam() {
  clearExamTimer();
  activeExam = {
    type: 'exam',
    title: 'Symulator egzaminu B2',
    questionIds: shuffle(window.B2_DATA.examPoolIds).slice(0, 36),
    index: 0,
    answers: [],
    durationSec: 45 * 60,
    startedAt: Date.now(),
  };
  examTimerHandle = setInterval(() => {
    if (!activeExam) {
      clearExamTimer();
      return;
    }
    renderExam();
    if (getRemainingExamSeconds() <= 0) {
      finishSession(activeExam);
      activeExam = null;
      clearExamTimer();
      renderAll();
    }
  }, 1000);
  renderExam();
}

function clearExamTimer() {
  if (examTimerHandle) {
    clearInterval(examTimerHandle);
    examTimerHandle = null;
  }
}

function getRemainingExamSeconds() {
  if (!activeExam) return 0;
  const elapsed = Math.floor((Date.now() - activeExam.startedAt) / 1000);
  return Math.max(0, activeExam.durationSec - elapsed);
}

function renderExam() {
  const root = document.getElementById('view-exam');
  if (!activeExam) {
    const latest = appState.history.find((h) => h.type === 'exam');
    root.innerHTML = `
      <div class="exam-grid">
        <aside class="panel">
          <h3>Symulator egzaminu</h3>
          <p>
            Pełniejszy trening na czas: 36 losowych pytań z większej puli. W środku znajdziesz miks gramatyki,
            vocabulary, readingu, tłumaczeń i transformacji.
          </p>
          <div class="tags">
            <span class="tag">36 pytań</span>
            <span class="tag">45 minut</span>
            <span class="tag">raport końcowy</span>
          </div>
          <button id="startExamBtn" class="primary-btn">Rozpocznij symulator</button>
          ${latest ? `<p class="muted">Ostatni wynik: <strong>${latest.score}%</strong> (${latest.correct}/${latest.total}) z dnia ${formatDate(latest.finishedAt)}.</p>` : ''}
        </aside>
        <section class="summary-card">
          <h4>Po co ten tryb</h4>
          <ul class="list-clean">
            <li>Sprawdza, jak radzisz sobie pod presją czasu.</li>
            <li>Łączy kilka typów zadań w jednym podejściu.</li>
            <li>Dobrze pokazuje realną gotowość do poziomu B2.</li>
          </ul>
        </section>
      </div>
    `;
    document.getElementById('startExamBtn').addEventListener('click', startExam);
    return;
  }
  renderSession(root, activeExam, 'exam');
}

function renderSession(root, session, kind) {
  const currentId = session.questionIds[session.index];
  const question = questionMap.get(currentId);
  const progress = session.answers.length;
  const timerMarkup = kind === 'exam' ? `<div class="timer-box">Pozostało: ${formatTime(getRemainingExamSeconds())}</div>` : '';

  if (!question) {
    root.innerHTML = '<div class="empty-state"><p>Nie udało się załadować pytań dla tej sesji.</p></div>';
    return;
  }

  root.innerHTML = `
    <div class="exam-grid">
      <aside class="panel">
        <h3>${session.title}</h3>
        <div class="kpi-row">
          <div class="kpi">
            <div class="kpi-label">Postęp</div>
            <div class="kpi-value">${progress + 1}/${session.questionIds.length}</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Ukończone</div>
            <div class="kpi-value">${progress}</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Tryb</div>
            <div class="kpi-value">${kind === 'exam' ? 'Timed' : 'Placement'}</div>
          </div>
        </div>
        <div style="margin-top:16px;">${timerMarkup}</div>
        <div class="card-actions" style="margin-top:16px;">
          <button id="abortSessionBtn" class="ghost-btn">Przerwij sesję</button>
        </div>
      </aside>
      <div id="sessionQuestionWrap"></div>
    </div>
  `;

  document.getElementById('abortSessionBtn').addEventListener('click', () => {
    if (!confirm('Czy na pewno chcesz przerwać tę sesję?')) return;
    if (kind === 'placement') activePlacement = null;
    if (kind === 'exam') {
      activeExam = null;
      clearExamTimer();
    }
    renderAll();
  });

  renderSingleQuestion(document.getElementById('sessionQuestionWrap'), question, {
    mode: kind,
    onNext: (payload) => {
      session.answers.push(payload);
      if (session.index >= session.questionIds.length - 1) {
        finishSession(session);
        if (kind === 'placement') activePlacement = null;
        if (kind === 'exam') {
          activeExam = null;
          clearExamTimer();
        }
        renderAll();
      } else {
        session.index += 1;
        if (kind === 'placement') renderPlacement();
        else renderExam();
      }
    },
  });
}

function renderSingleQuestion(root, question, config) {
  const baseMarkup = buildQuestionMarkup(question);
  root.innerHTML = baseMarkup;

  if (question.type === 'mcq') {
    attachMcqHandlers(root, question, config);
  } else {
    attachTypedHandlers(root, question, config);
  }
}

function buildQuestionMarkup(question) {
  const reading = question.readingText ? `
    <article class="reading-passage">
      <h4>${question.readingTitle}</h4>
      <div class="reading-text">${question.readingText}</div>
    </article>
  ` : '';

  const answerArea = question.type === 'mcq'
    ? `
      <div class="options-list">
        ${question.options.map((option, index) => `
          <button class="answer-btn" data-option="${index}">
            <strong>${String.fromCharCode(65 + index)}.</strong> ${option}
          </button>
        `).join('')}
      </div>
    `
    : `
      <div class="answer-box">
        <label for="typedAnswer" class="muted">Wpisz odpowiedź po angielsku:</label>
        <textarea id="typedAnswer" placeholder="Wpisz swoją odpowiedź tutaj..."></textarea>
        <div class="feedback-actions" style="margin-top:14px;">
          <button id="submitTypedBtn" class="exercise-submit">Sprawdź odpowiedź</button>
        </div>
      </div>
    `;

  return `
    <article class="exercise-card">
      <div class="exercise-header">
        <div>
          <div class="exercise-index">${question.skill} · ${question.category}</div>
          <h3 class="exercise-title">${question.prompt}</h3>
        </div>
      </div>
      ${reading}
      <div class="question-box">
        ${answerArea}
      </div>
      <div id="feedbackMount"></div>
    </article>
  `;
}

function attachMcqHandlers(root, question, config) {
  const buttons = root.querySelectorAll('[data-option]');
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      const selected = Number(button.dataset.option);
      const isCorrect = selected === question.answer;
      buttons.forEach((btn) => {
        btn.disabled = true;
        const idx = Number(btn.dataset.option);
        if (idx === question.answer) btn.classList.add('correct');
        if (idx === selected && selected !== question.answer) btn.classList.add('wrong');
      });

      recordAnswer(question, isCorrect, question.options[selected], { mode: config.mode });
      showFeedback(root, question, isCorrect, question.options[selected], () => {
        config.onNext({ questionId: question.id, correct: isCorrect, userAnswer: question.options[selected] });
      });
    });
  });
}

function attachTypedHandlers(root, question, config) {
  const submitBtn = root.querySelector('#submitTypedBtn');
  const textarea = root.querySelector('#typedAnswer');

  const submit = () => {
    const value = textarea.value.trim();
    if (!value) {
      textarea.focus();
      return;
    }
    const result = evaluateTypedAnswer(question, value);
    textarea.disabled = true;
    submitBtn.disabled = true;
    recordAnswer(question, result.correct, value, { mode: config.mode });
    showFeedback(root, question, result.correct, value, () => {
      config.onNext({ questionId: question.id, correct: result.correct, userAnswer: value });
    }, result.matchInfo);
  };

  submitBtn.addEventListener('click', submit);
  textarea.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') submit();
  });
}

function evaluateTypedAnswer(question, answer) {
  const normalized = normalizeText(answer);
  const acceptable = [question.sampleAnswer, ...(question.acceptableAnswers || [])]
    .filter(Boolean)
    .map(normalizeText);

  if (acceptable.includes(normalized)) {
    return { correct: true, matchInfo: 'Idealnie — odpowiedź zgadza się z wzorcową wersją.' };
  }

  const required = (question.requiredWords || []).map(normalizeText).filter(Boolean);
  if (!required.length) {
    return { correct: false, matchInfo: 'Brak pełnego dopasowania do odpowiedzi wzorcowej.' };
  }

  const matched = required.filter((word) => normalized.includes(word)).length;
  const ratio = matched / required.length;
  const correct = ratio >= 0.8;
  return {
    correct,
    matchInfo: `Wykryto ${matched}/${required.length} kluczowych elementów odpowiedzi.`
  };
}

function showFeedback(root, question, isCorrect, userAnswer, onNext, matchInfo = '') {
  const mount = root.querySelector('#feedbackMount');
  mount.innerHTML = `
    <div class="feedback">
      <span class="status-pill ${isCorrect ? 'correct' : 'wrong'}">${isCorrect ? 'Poprawnie' : 'Jeszcze nie to'}</span>
      <div class="translation-box">
        <strong>Twoja odpowiedź:</strong>
        <div>${escapeHtml(String(userAnswer))}</div>
      </div>
      <div class="translation-box">
        <strong>Poprawna odpowiedź:</strong>
        <div>${escapeHtml(question.sampleAnswer || question.options[question.answer])}</div>
      </div>
      <div class="explanation-box">
        <strong>Wyjaśnienie:</strong>
        <div>${escapeHtml(question.explanation)}</div>
        ${matchInfo ? `<div class="muted" style="margin-top:8px;">${escapeHtml(matchInfo)}</div>` : ''}
      </div>
      <div class="feedback-actions">
        <button id="nextQuestionBtn" class="primary-btn">Dalej</button>
      </div>
    </div>
  `;

  mount.querySelector('#nextQuestionBtn').addEventListener('click', onNext);
}

function renderFlashcards() {
  const root = document.getElementById('view-flashcards');
  if (!flashcards.length) {
    root.innerHTML = '<div class="empty-state"><p>Brak fiszek w bazie.</p></div>';
    return;
  }
  const fl = flashcards[flashcardIndex];
  
  root.innerHTML = `
    <section class="practice-grid">
      <aside class="panel" style="display:flex; flex-direction:column;">
        <h3>Fiszki</h3>
        <p>Przeglądaj, odwracaj i sprawdzaj swoje słownictwo w ułamku sekundy.</p>
        <div class="kpi-row" style="margin-top: 16px;">
          <div class="kpi">
            <div class="kpi-label">Karta</div>
            <div class="kpi-value">${flashcardIndex + 1} / ${flashcards.length}</div>
          </div>
        </div>
        <div class="card-actions" style="margin-top: 24px; justify-content:space-between;">
          <button id="prevFlashBtn" class="secondary-btn" ${flashcardIndex === 0 ? 'disabled' : ''}>&larr; Wróć</button>
          <button id="nextFlashBtn" class="primary-btn" ${flashcardIndex === flashcards.length - 1 ? 'disabled' : ''}>Dalej &rarr;</button>
        </div>
        <p class="muted" style="margin-top:24px; font-size:0.9rem; border-top:1px solid rgba(255,255,255,0.1); padding-top:16px;">
          <strong>Tip:</strong> Kliknij kartę, aby zobaczyć tłumaczenie. Użyj strzałek, aby przeskakiwać.
        </p>
      </aside>
      
      <div class="flashcard-container" id="fc-container">
        <div class="flashcard" id="fc-card">
          <div class="flashcard-face flashcard-front">
            <div class="flashcard-type">${escapeHtml(fl.hint)}</div>
            <div class="flashcard-word">${escapeHtml(fl.word)}</div>
          </div>
          <div class="flashcard-face flashcard-back">
            <div class="flashcard-translation">${escapeHtml(fl.translation)}</div>
            ${fl.example ? `<div class="flashcard-example">"${escapeHtml(fl.example)}"</div>` : ''}
          </div>
        </div>
      </div>
    </section>
  `;

  document.getElementById('fc-container').addEventListener('click', () => {
    document.getElementById('fc-card').classList.toggle('flipped');
  });

  const prevBtn = document.getElementById('prevFlashBtn');
  if (prevBtn) prevBtn.addEventListener('click', () => {
    if (flashcardIndex > 0) {
      flashcardIndex--;
      renderFlashcards();
    }
  });

  const nextBtn = document.getElementById('nextFlashBtn');
  if (nextBtn) nextBtn.addEventListener('click', () => {
    if (flashcardIndex < flashcards.length - 1) {
      flashcardIndex++;
      renderFlashcards();
    }
  });
}


function finishSession(session) {
  const correct = session.answers.filter((item) => item.correct).length;
  const total = session.questionIds.length;
  const score = accuracy(total, correct);
  appState.history.unshift({
    id: crypto.randomUUID(),
    type: session.type,
    title: session.title,
    correct,
    total,
    score,
    finishedAt: new Date().toISOString(),
  });
  appState.history = appState.history.slice(0, 20);
  saveState();
}

function renderMistakes() {
  const root = document.getElementById('view-mistakes');
  if (!appState.mistakes.length) {
    root.innerHTML = `
      <div class="empty-state">
        <h3>Bank błędów jest pusty</h3>
        <p>To dobrze. Gdy popełnisz błąd w trybie ćwiczeń lub w testach, pytanie pojawi się tutaj wraz z poprawną odpowiedzią i wyjaśnieniem.</p>
      </div>
    `;
    return;
  }

  root.innerHTML = `
    <section class="mistakes-grid">
      ${appState.mistakes.map((item) => `
        <article class="mistake-card">
          <div class="exercise-index">${item.skill} · ${item.category}</div>
          <h4>${escapeHtml(item.prompt)}</h4>
          <div class="mistake-answer">
            <div class="muted">Twoja odpowiedź</div>
            <div>${escapeHtml(item.userAnswer)}</div>
          </div>
          <div class="mistake-answer" style="margin-top:12px;">
            <div class="muted">Wzorcowa odpowiedź</div>
            <div>${escapeHtml(item.sampleAnswer)}</div>
          </div>
          <div class="mistake-answer" style="margin-top:12px;">
            <div class="muted">Wyjaśnienie</div>
            <div>${escapeHtml(item.explanation)}</div>
          </div>
        </article>
      `).join('')}
    </section>
  `;
}

function renderStats() {
  const root = document.getElementById('view-stats');
  const acc = accuracy(appState.attempted, appState.correct);
  const recent = appState.recentAnswers.slice(0, 20);
  const recentAcc = accuracy(recent.length, recent.filter((x) => x.correct).length);
  const readiness = (() => {
    if (acc >= 85) return 'B2+ / bardzo mocny B2';
    if (acc >= 70) return 'stabilny B2';
    if (acc >= 55) return 'B1+ / w drodze do B2';
    return 'poniżej docelowego B2';
  })();

  const skillRows = Object.entries(appState.skillStats).map(([skill, stats]) => `
    <article class="result-card">
      <h4>${skill}</h4>
      <div class="result-summary">
        <div class="score-ring" style="--value:${accuracy(stats.attempted, stats.correct) * 3.6}deg"><span>${accuracy(stats.attempted, stats.correct)}%</span></div>
        <div>
          <div class="result-meta">Poprawne: ${stats.correct}</div>
          <div class="result-meta">Wszystkie próby: ${stats.attempted}</div>
        </div>
      </div>
    </article>
  `).join('');

  const historyMarkup = appState.history.length
    ? appState.history.map((item) => `
      <div class="result-item">
        <h5>${item.title}</h5>
        <div class="result-meta">${formatDate(item.finishedAt)} · ${item.score}% · ${item.correct}/${item.total}</div>
      </div>
    `).join('')
    : '<div class="empty-state"><p>Statystyki będą bardziej wartościowe po pierwszych kilku sesjach.</p></div>';

  root.innerHTML = `
    <section class="stats-grid">
      ${buildStatCard('Łączna skuteczność', `${acc}%`, readiness)}
      ${buildStatCard('Ostatnie 20 odpowiedzi', `${recentAcc}%`, 'Pokazuje aktualną formę')}
      ${buildStatCard('Aktualna seria', appState.streak, 'Liczba poprawnych odpowiedzi z rzędu')}
      ${buildStatCard('Najlepsza seria', appState.bestStreak, 'Twój rekord')}
    </section>

    <section class="dashboard-grid" style="margin-top:16px;">
      <div class="panel">
        <h3>Wyniki według obszaru</h3>
        <div class="results-grid">${skillRows}</div>
      </div>
      <div class="panel">
        <h3>Historia sesji</h3>
        <div class="result-list">${historyMarkup}</div>
      </div>
    </section>
  `;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(value) {
  return new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function formatTime(totalSec) {
  const minutes = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const seconds = Math.floor(totalSec % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function renderAll() {
  renderDashboard();
  renderPlacement();
  renderPractice();
  renderExam();
  renderMistakes();
  renderStats();
  renderFlashcards();
}

initNavigation();
initControls();
renderAll();
