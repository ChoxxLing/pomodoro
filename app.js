/**
 * ================================================================
 * POMODORO FOCUS TIMER v3 — app.js
 * ================================================================
 *
 * ARCHITECTURE (6 independent modules + INIT):
 *
 *  TIMER_SYSTEM   → Independent per-session countdown state.
 *                   Each timer remembers its own timeLeft.
 *                   Only one runs at a time. Tab-persistence
 *                   via Date.now() timestamps.
 *
 *  LAYOUT_SYSTEM  → Controls which card is center (hero) and
 *                   which are sides. Manages the CSS class
 *                   transitions that animate the switch.
 *
 *  AUDIO_SYSTEM   → Web Audio API alarm tones + per-session
 *                   uploaded music files (Object URLs).
 *
 *  TASK_SYSTEM    → Add / complete / delete tasks.
 *                   localStorage persistence.
 *
 *  SETTINGS_SYSTEM→ Settings drawer bindings (sound, music,
 *                   behaviour toggles). Restore defaults button.
 *
 *  THEME_SYSTEM   → Light / dark toggle with persistence.
 *
 * ================================================================
 */

'use strict';

/* ================================================================
   CONSTANTS
================================================================ */

/** Default durations in minutes — used by Restore Defaults */
const DEFAULTS = {
  work:       25,
  shortBreak:  5,
  longBreak:  15,
};

const SESSION_META = {
  work:        { label: 'Work',        icon: '🍅' },
  shortBreak:  { label: 'Short Break', icon: '☕' },
  longBreak:   { label: 'Long Break',  icon: '🌿' },
};

const RING_C = 603.19;   // 2π × 96 — circumference of the SVG ring

/* ================================================================
   TIMER SYSTEM
   ================================================================
   Each of the three sessions maintains its own independent state:
     - durationSecs : total duration (seconds), editable
     - timeLeft     : remaining seconds (survives session switches)
     - startTs      : Date.now() when the timer last started
                      (null when not running / paused)
     - timeAtStart  : timeLeft snapshot at the moment of start
                      (used for tab-persistent drift correction)

   Only one session can be "running" at a time. When the user
   switches active sessions, the previously running timer is
   paused (its timeLeft is preserved), and the newly active timer
   either resumes or starts fresh.

   TAB PERSISTENCE:
   Instead of decrementing a counter every second, we record the
   wall-clock start time (Date.now()) and compute:
     timeLeft = timeAtStart - floor((Date.now() - startTs) / 1000)
   This means the countdown is always correct regardless of how
   infrequently the setInterval fires in a background tab.
================================================================ */
const TIMER_SYSTEM = (() => {

  /* Per-session state */
  const STATE = {
    work:       { durationSecs: 25*60, timeLeft: 25*60, startTs: null, timeAtStart: 0 },
    shortBreak: { durationSecs:  5*60, timeLeft:  5*60, startTs: null, timeAtStart: 0 },
    longBreak:  { durationSecs: 15*60, timeLeft: 15*60, startTs: null, timeAtStart: 0 },
  };

  let runningSession = null;   // which session is currently counting down
  let intervalId     = null;   // the single setInterval handle

  /* Pomodoro cycle counters */
  let workDoneInCycle = 0;
  let totalPomodoros  = 0;
  let totalCycles     = 0;
  let totalFocusMins  = 0;

  /* Callbacks registered by the LAYOUT_SYSTEM */
  let onTickCb       = null;   // called every ~250ms with (session, timeLeft, total)
  let onCompleteCb   = null;   // called when a timer reaches zero (session)

  /* ── Getters ── */
  const getState = session => STATE[session];
  const isRunning     = ()  => runningSession !== null;
  const getRunning    = ()  => runningSession;
  const getStats      = ()  => ({ totalPomodoros, totalCycles, totalFocusMins });

  /**
   * Compute the real timeLeft for the running session using wall-clock time.
   * This corrects for browser throttling in background tabs.
   * @returns {number} corrected timeLeft in seconds
   */
  function computeTimeLeft(session) {
    const s = STATE[session];
    if (!s.startTs) return s.timeLeft;
    const elapsed = Date.now() - s.startTs;
    return Math.max(0, s.timeAtStart - Math.floor(elapsed / 1000));
  }

  /** Start the countdown for `session`. Pauses any currently running timer. */
  function start(session) {
    if (runningSession && runningSession !== session) {
      /* Pause the previously running timer without losing its timeLeft */
      pause(runningSession);
    }

    const s = STATE[session];
    if (s.timeLeft === 0) return;  // already expired, nothing to do

    runningSession     = session;
    s.startTs          = Date.now();
    s.timeAtStart      = s.timeLeft;

    /* High-frequency tick (250ms) for smooth UI updates.
       The actual countdown value is derived from wall-clock time, not tick count. */
    clearInterval(intervalId);
    intervalId = setInterval(() => tick(session), 250);
  }

  /** Pause the running timer, preserving its timeLeft. */
  function pause(session) {
    const s = STATE[session];
    /* Snapshot the real remaining time before stopping the interval */
    if (s.startTs) {
      s.timeLeft = computeTimeLeft(session);
      s.startTs  = null;
    }
    clearInterval(intervalId);
    intervalId     = null;
    runningSession = null;
  }

  /**
   * Toggle between start and pause for `session`.
   * If a different session was running, it is paused automatically.
   */
  function togglePlayPause(session) {
    if (runningSession === session) {
      pause(session);
    } else {
      start(session);
    }
  }

  /** Reset `session`'s timer to its full duration. */
  function reset(session) {
    if (runningSession === session) pause(session);
    const s = STATE[session];
    s.timeLeft     = s.durationSecs;
    s.startTs      = null;
    s.timeAtStart  = 0;
    onTickCb && onTickCb(session, s.timeLeft, s.durationSecs);
  }

  /** Skip the current timer — treat it as complete. */
  function skip(session) {
    if (runningSession === session) pause(session);
    STATE[session].timeLeft = 0;
    onCompleteCb && onCompleteCb(session, /* silent */ true);
  }

  /**
   * Change the duration for a session.
   * If the timer is not running: also resets timeLeft to the new duration.
   * If the timer IS running: updates total duration only (preserves countdown).
   * @param {string} session
   * @param {number} minutes
   */
  function setDuration(session, minutes) {
    const mins  = Math.max(1, Math.min(120, minutes));
    const secs  = mins * 60;
    const s     = STATE[session];
    s.durationSecs = secs;
    /* Only reset timeLeft if this session isn't actively counting down */
    if (runningSession !== session) {
      s.timeLeft = secs;
    }
  }

  /** Internal tick: recompute timeLeft from wall clock and fire callbacks. */
  function tick(session) {
    const corrected = computeTimeLeft(session);
    STATE[session].timeLeft = corrected;

    onTickCb && onTickCb(session, corrected, STATE[session].durationSecs);

    if (corrected <= 0) {
      clearInterval(intervalId);
      intervalId     = null;
      runningSession = null;

      /* Update cycle counters */
      if (session === 'work') {
        workDoneInCycle++;
        totalPomodoros++;
        totalFocusMins += Math.round(STATE.work.durationSecs / 60);
      }

      onCompleteCb && onCompleteCb(session, /* silent */ false);
    }
  }

  /**
   * Determine the next logical session after `session` completes.
   * Rule: every 4th work session → long break; otherwise → short break.
   */
  function getNextSession(session) {
    if (session === 'work') {
      if (workDoneInCycle >= 4) {
        workDoneInCycle = 0;
        totalCycles++;
        return 'longBreak';
      }
      return 'shortBreak';
    }
    return 'work';
  }

  /** Tab-visibility correction: called when the user returns to the tab. */
  function onTabVisible() {
    if (!runningSession) return;
    const corrected = computeTimeLeft(runningSession);
    STATE[runningSession].timeLeft = corrected;
    /* Fire a tick immediately so the UI updates without waiting 250ms */
    onTickCb && onTickCb(
      runningSession, corrected, STATE[runningSession].durationSecs
    );
    if (corrected <= 0) tick(runningSession);
  }

  function onTick(cb)     { onTickCb     = cb; }
  function onComplete(cb) { onCompleteCb = cb; }

  /* Persist & restore today's stats */
  function saveStats() {
    try {
      const key = `pomStats_${new Date().toISOString().slice(0,10)}`;
      localStorage.setItem(key, JSON.stringify({ totalPomodoros, totalCycles, totalFocusMins, workDoneInCycle }));
    } catch(_) {}
  }
  function loadStats() {
    try {
      const key  = `pomStats_${new Date().toISOString().slice(0,10)}`;
      const data = localStorage.getItem(key);
      if (!data) return;
      const s = JSON.parse(data);
      totalPomodoros  = s.totalPomodoros  || 0;
      totalCycles     = s.totalCycles     || 0;
      totalFocusMins  = s.totalFocusMins  || 0;
      workDoneInCycle = s.workDoneInCycle || 0;
    } catch(_) {}
  }

  window.addEventListener('beforeunload', saveStats);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onTabVisible();
  });

  return {
    getState, isRunning, getRunning, getStats,
    start, pause, togglePlayPause, reset, skip,
    setDuration, getNextSession,
    onTick, onComplete,
    loadStats,
  };
})();


/* ================================================================
   LAYOUT SYSTEM
   ================================================================
   Controls:
   1. Which card is "active" (hero, center) vs "side" (compact)
   2. The CSS `data-active` attribute on the arena that drives
      the flexbox `order` CSS rules (centering the active card)
   3. The class toggles (.active on cards) that show/hide the
      two face layers (active-face / side-face)

   ANIMATION SEQUENCE when switching sessions:
   ────────────────────────────────────────────
   a) Add `.switching` to the arena → freezes pointer events
   b) Remove `.active` from the old card → its active-face fades
      out, side-face fades in (CSS transitions, ~380ms)
   c) Update `data-active` on the arena → CSS `order` rules fire,
      cards reposition via flex (animated by flex transition)
   d) Add `.active` to the new card → its side-face fades out,
      active-face fades in
   e) After transition completes, remove `.switching`

   The timer displays (big-time, ring, progress) are updated by
   the TIMER_SYSTEM's onTick callback during normal operation.
================================================================ */
const LAYOUT_SYSTEM = (() => {

  const arena     = document.getElementById('timersArena');
  const SESSIONS  = ['work', 'shortBreak', 'longBreak'];
  let   active    = 'work';

  /** Get the .timer-card DOM element for a session. */
  const card    = s => document.getElementById(`card-${s}`);
  const bigTime = s => document.getElementById(s === 'work' ? 'bigTime' : `bigTime-${s}`);
  const ringArc = s => document.getElementById(s === 'work' ? 'ringArc' : `ringArc-${s}`);
  const progFill= s => document.getElementById(s === 'work' ? 'progressFill' : `progressFill-${s}`);
  const dotWrap = s => document.getElementById(s === 'work' ? 'cycleDots' : `cycleDots-${s}`);

  /* Side-face elements (present in all cards) */
  const sfTime  = s => document.querySelector(`[data-session-time="${s}"]`);
  const sfProg  = s => document.querySelector(`[data-progress="${s}"]`);

  /** Format seconds → "MM:SS" */
  const fmt = secs => {
    const m = String(Math.floor(secs / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    return `${m}:${s}`;
  };

  /**
   * Update all timer displays (ring, big-time, progress bars,
   * side-face time) for `session` with current values.
   */
  function updateDisplay(session, timeLeft, totalSecs) {
    const time = fmt(timeLeft);

    /* Big time display (hero face) */
    const bt = bigTime(session);
    if (bt) bt.textContent = time;

    /* SVG ring arc */
    const arc = ringArc(session);
    if (arc) {
      const pct    = totalSecs > 0 ? (totalSecs - timeLeft) / totalSecs : 0;
      const offset = RING_C * (1 - pct);
      arc.style.strokeDashoffset = offset;
    }

    /* Hero linear progress bar */
    const pf = progFill(session);
    if (pf) {
      const pct = totalSecs > 0 ? ((totalSecs - timeLeft) / totalSecs * 100).toFixed(1) : 0;
      pf.style.width = `${pct}%`;
    }

    /* Side-face time label */
    const st = sfTime(session);
    if (st) st.textContent = time;

    /* Side-face mini progress bar */
    const sp = sfProg(session);
    if (sp) {
      const pct = totalSecs > 0 ? ((totalSecs - timeLeft) / totalSecs * 100).toFixed(1) : 0;
      sp.style.width = `${pct}%`;
    }

    /* Browser title (active session only) */
    if (session === active) {
      document.title = `${time} — ${SESSION_META[session].label} | Focus`;
    }

    /* Ticking animation on the big number */
    const isRunning = TIMER_SYSTEM.getRunning() === session;
    if (bt) bt.classList.toggle('ticking', isRunning);
  }

  /** Rebuild the cycle dots for all cards. */
  function updateCycleDots() {
    const { totalPomodoros } = TIMER_SYSTEM.getStats();
    const dotCount = totalPomodoros % 4;  // 0–3 filled dots

    SESSIONS.forEach(session => {
      const wrap = dotWrap(session);
      if (!wrap) return;
      wrap.innerHTML = '';
      for (let i = 0; i < 4; i++) {
        const d = document.createElement('span');
        d.className = `cdot${i < dotCount ? ' done' : ''}`;
        wrap.appendChild(d);
      }
    });
  }

  /** Update the stats strip inside the hero card. */
  function updateStats() {
    const { totalPomodoros, totalCycles, totalFocusMins } = TIMER_SYSTEM.getStats();
    const h = Math.floor(totalFocusMins / 60);
    const m = totalFocusMins % 60;
    const focusStr = h > 0 ? `${h}h${m}m` : `${m}m`;

    /* Work card stats */
    const el = id => document.getElementById(id);
    el('statToday')  && (el('statToday').textContent  = totalPomodoros);
    el('statCycles') && (el('statCycles').textContent = totalCycles);
    el('statFocus')  && (el('statFocus').textContent  = focusStr);
    /* Short break card stats (mirrors) */
    el('statToday-sb')  && (el('statToday-sb').textContent  = totalPomodoros);
    el('statCycles-sb') && (el('statCycles-sb').textContent = totalCycles);
    el('statFocus-sb')  && (el('statFocus-sb').textContent  = focusStr);
    /* Long break card stats (mirrors) */
    el('statToday-lb')  && (el('statToday-lb').textContent  = totalPomodoros);
    el('statCycles-lb') && (el('statCycles-lb').textContent = totalCycles);
    el('statFocus-lb')  && (el('statFocus-lb').textContent  = focusStr);
  }

  /**
   * Update the play/pause icon state on ALL three cards.
   * The active running session shows pause icon; all others show play.
   */
  function syncPlayPauseIcons() {
    const running = TIMER_SYSTEM.getRunning();
    SESSIONS.forEach(session => {
      /* Selector covers both the main #playPauseBtn and data-playpause buttons */
      const btn = session === 'work'
        ? document.getElementById('playPauseBtn')
        : document.querySelector(`[data-playpause="${session}"]`);
      if (!btn) return;

      const play  = btn.querySelector('.ico-play');
      const pause = btn.querySelector('.ico-pause');
      if (!play || !pause) return;

      const isActive = running === session;
      play.classList.toggle('hidden',  isActive);
      pause.classList.toggle('hidden', !isActive);
    });
  }

  /**
   * Switch the active (hero) session.
   * This is the main UI switching logic.
   *
   * ANIMATION:
   * 1. Lock interactions (.switching)
   * 2. Swap .active class between cards
   * 3. Update arena data-active (triggers CSS order/flex changes)
   * 4. Remove .switching after transition completes
   */
  function switchActive(newSession, andStart = false) {
    if (newSession === active && !andStart) return;

    const prevSession = active;
    active = newSession;

    /* Step 1: Lock arena during transition */
    arena.classList.add('switching');

    /* Step 2: Update .active class on each card */
    SESSIONS.forEach(s => card(s).classList.toggle('active', s === newSession));

    /* Step 3: Update data-active → triggers CSS order & flex transitions */
    arena.setAttribute('data-active', newSession);

    /* Update aria attributes */
    SESSIONS.forEach(s => {
      const af = card(s).querySelector('.active-face');
      const sf = card(s).querySelector('.side-face');
      af.setAttribute('aria-hidden', s !== newSession);
      sf.setAttribute('aria-hidden', s === newSession);
    });

    /* Step 4: Unlock after the CSS transition duration (~550ms) */
    setTimeout(() => arena.classList.remove('switching'), 580);

    /* Optionally start the new session */
    if (andStart) {
      TIMER_SYSTEM.start(newSession);
      AUDIO_SYSTEM.playSesssionMusic(newSession);
    }

    syncPlayPauseIcons();
  }

  /** Flash the ring arc (session complete visual) */
  function flashArc(session) {
    const arc = ringArc(session);
    if (!arc) return;
    arc.classList.remove('flash');
    void arc.offsetWidth;
    arc.classList.add('flash');
    setTimeout(() => arc.classList.remove('flash'), 1100);
  }

  /** Shake + glow the active card (session complete) */
  function shakeCard(session) {
    const c = card(session);
    c.classList.remove('shake', 'glowing');
    void c.offsetWidth;
    c.classList.add('shake', 'glowing');
    setTimeout(() => c.classList.remove('shake', 'glowing'), 1400);
  }

  const getActive = () => active;

  return {
    switchActive, updateDisplay, updateCycleDots, updateStats,
    syncPlayPauseIcons, flashArc, shakeCard, getActive, fmt,
  };
})();


/* ================================================================
   AUDIO SYSTEM
   ================================================================
   Two audio subsystems:

   1. ALARM — Web Audio API synthesised tones (bell, chime, digital).
      Generated on the fly; no external files needed.

   2. SESSION MUSIC — User-uploaded audio files per session.
      When a file is uploaded:
        • URL.createObjectURL(file) creates an in-memory URL
        • An <audio loop> element is stored in the `tracks` map
        • When that session becomes active, its track plays
        • When the session ends or is switched, the track pauses
      Object URLs live for the page session only and cannot be
      persisted to localStorage (too large, security constraints).
================================================================ */
const AUDIO_SYSTEM = (() => {

  let audioCtx = null;
  let alarmVol = 0.7;
  let musicVol = 0.6;
  let muted    = false;

  /* Music tracks: session → { audio: HTMLAudioElement, name: string } | null */
  const tracks = { work: null, shortBreak: null, longBreak: null };
  let   playingSession = null;  // which session's music is currently playing

  function getCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  /** Play an alarm tone when a session completes. */
  function playAlarm(type = 'bell') {
    if (muted || type === 'none') return;
    try {
      const ctx = getCtx();
      const now = ctx.currentTime;
      const vol = alarmVol;

      if (type === 'bell') {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(440, now + 1.2);
        gain.gain.setValueAtTime(vol, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 1.5);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(now); osc.stop(now + 1.5);

      } else if (type === 'chime') {
        [0, 0.3, 0.6].forEach((delay, i) => {
          const osc  = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(523.25 * Math.pow(1.25, i), now + delay);
          gain.gain.setValueAtTime(vol * 0.8, now + delay);
          gain.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.6);
          osc.connect(gain); gain.connect(ctx.destination);
          osc.start(now + delay); osc.stop(now + delay + 0.6);
        });

      } else if (type === 'digital') {
        [0, 0.18, 0.36].forEach(delay => {
          const osc  = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'square';
          osc.frequency.setValueAtTime(1046.5, now + delay);
          gain.gain.setValueAtTime(vol * 0.4, now + delay);
          gain.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.12);
          osc.connect(gain); gain.connect(ctx.destination);
          osc.start(now + delay); osc.stop(now + delay + 0.12);
        });
      }
    } catch(e) { console.warn('Alarm error:', e); }
  }

  /** Load an uploaded audio file for a session. */
  function loadMusicFile(session, file) {
    /* Revoke previous Object URL to free memory */
    if (tracks[session]) {
      tracks[session].audio.pause();
      URL.revokeObjectURL(tracks[session].audio.src);
    }
    const url   = URL.createObjectURL(file);
    const audio = new Audio(url);
    audio.loop   = true;
    audio.volume = musicVol;
    tracks[session] = { audio, name: file.name };

    /* Update settings drawer labels */
    const nameEl = document.getElementById(`musicName-${session}`);
    const rmBtn  = document.getElementById(`musicRm-${session}`);
    if (nameEl) nameEl.textContent = file.name;
    if (rmBtn)  rmBtn.classList.remove('hidden');
  }

  /** Remove the uploaded music for a session. */
  function removeMusicTrack(session) {
    if (!tracks[session]) return;
    tracks[session].audio.pause();
    URL.revokeObjectURL(tracks[session].audio.src);
    tracks[session] = null;
    if (playingSession === session) {
      playingSession = null;
      updateNowPlayingBadge(null);
    }
    const nameEl = document.getElementById(`musicName-${session}`);
    const rmBtn  = document.getElementById(`musicRm-${session}`);
    if (nameEl) nameEl.textContent = 'No file';
    if (rmBtn)  rmBtn.classList.add('hidden');
  }

  /** Start playing session music when a session becomes active/starts. */
  function playSesssionMusic(session) {
    stopAllMusic();
    if (!tracks[session] || muted) return;
    const { audio, name } = tracks[session];
    audio.volume = musicVol;
    audio.currentTime = 0;
    audio.play().then(() => {
      playingSession = session;
      updateNowPlayingBadge(name);
    }).catch(e => console.warn('Music autoplay blocked:', e));
  }

  /** Pause all session music. */
  function stopAllMusic() {
    Object.values(tracks).forEach(t => t && t.audio.pause());
    playingSession = null;
    updateNowPlayingBadge(null);
  }

  /** Update the now-playing badge in the top bar. */
  function updateNowPlayingBadge(name) {
    const badge  = document.getElementById('nowPlaying');
    const npName = document.getElementById('npName');
    if (!badge) return;
    if (name) {
      npName.textContent = name;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  function setAlarmVolume(v)  { alarmVol = v; }
  function setMusicVolume(v)  {
    musicVol = v;
    Object.values(tracks).forEach(t => t && (t.audio.volume = v));
  }
  function setMuted(m) { muted = m; if (m) stopAllMusic(); }

  /* Warm up AudioContext on first user gesture */
  document.addEventListener('click', () => { try { getCtx(); } catch(_) {} }, { once: true });

  return {
    playAlarm, loadMusicFile, removeMusicTrack,
    playSesssionMusic, stopAllMusic,
    setAlarmVolume, setMusicVolume, setMuted,
  };
})();


/* ================================================================
   NOTIFICATION SYSTEM
================================================================ */
const NOTIF_SYSTEM = (() => {
  const banner   = document.getElementById('notifBanner');
  const emojiEl  = document.getElementById('notifEmoji');
  const msgEl    = document.getElementById('notifMsg');

  function show(completed, next) {
    emojiEl.textContent = SESSION_META[completed].icon;
    msgEl.textContent   = `${SESSION_META[completed].label} done — ${SESSION_META[next].label} up next!`;
    banner.classList.add('show');
    setTimeout(() => banner.classList.remove('show'), 3500);

    /* Browser push notification */
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('🍅 Pomodoro', {
        body: `${SESSION_META[completed].label} finished! Starting ${SESSION_META[next].label}.`,
      });
    }
  }

  return { show };
})();


/* ================================================================
   TASK SYSTEM
   ================================================================
   Features:
   - Add tasks via input field + button (or Enter key)
   - Each task: checkbox (complete), text, timestamp, delete button
   - Completed tasks show strikethrough + fade
   - Filter tabs: All / Active / Done
   - "Clear done" button removes all completed tasks
   - localStorage persistence: saves after every mutation

   DATA STRUCTURE:
     tasks = [{ id, text, done, createdAt }, ...]
     Stored in localStorage as JSON under key 'pomodoroTasks'.
================================================================ */
const TASK_SYSTEM = (() => {

  const listEl    = document.getElementById('taskList');
  const emptyEl   = document.getElementById('taskEmpty');
  const inputEl   = document.getElementById('newTaskInput');
  const addBtn    = document.getElementById('addTaskBtn');
  const badgeEl   = document.getElementById('tasksBadge');
  const clearBtn  = document.getElementById('clearDoneBtn');

  const STORAGE_KEY = 'pomodoroTasks';
  let   tasks       = [];
  let   filter      = 'all';

  /* ── Persistence ── */
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) tasks = JSON.parse(raw);
    } catch(_) { tasks = []; }
    render();
    badge();
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); } catch(_) {}
  }

  /* ── CRUD ── */
  function add(text) {
    const t = text.trim();
    if (!t) return;
    tasks.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2,5),
      text: t,
      done: false,
      createdAt: new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }),
    });
    save();
    render();
    badge();
    inputEl.value = '';
    inputEl.focus();
  }

  function toggle(id) {
    const task = tasks.find(t => t.id === id);
    if (task) { task.done = !task.done; save(); render(); badge(); }
  }

  function remove(id) {
    tasks = tasks.filter(t => t.id !== id);
    save(); render(); badge();
  }

  function clearDone() {
    tasks = tasks.filter(t => !t.done);
    save(); render(); badge();
  }

  /* ── Render ── */
  function visible() {
    if (filter === 'active') return tasks.filter(t => !t.done);
    if (filter === 'done')   return tasks.filter(t =>  t.done);
    return tasks;
  }

  function render() {
    listEl.querySelectorAll('.task-item').forEach(el => el.remove());
    const v = visible();
    emptyEl.classList.toggle('hidden', v.length > 0);

    v.forEach(task => {
      const li = document.createElement('li');
      li.className = `task-item${task.done ? ' done' : ''}`;
      li.dataset.id = task.id;
      li.innerHTML = `
        <input type="checkbox" class="task-cb" id="tcb-${task.id}" ${task.done ? 'checked' : ''} aria-label="Mark as ${task.done ? 'incomplete' : 'complete'}" />
        <div class="task-body">
          <label class="task-text" for="tcb-${task.id}">${esc(task.text)}</label>
          <span class="task-time">${task.createdAt}</span>
        </div>
        <button class="task-del" data-id="${task.id}" aria-label="Delete task" title="Delete">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>`;

      li.querySelector('.task-cb').addEventListener('change', () => toggle(task.id));
      li.querySelector('.task-del').addEventListener('click', () => remove(task.id));
      listEl.appendChild(li);
    });
  }

  function badge() {
    const done  = tasks.filter(t => t.done).length;
    badgeEl.textContent = `${done} / ${tasks.length}`;
  }

  function setFilter(f) {
    filter = f;
    document.querySelectorAll('.filter-tab').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.filter === f)
    );
    render();
  }

  /* ── Init ── */
  function init() {
    load();
    addBtn.addEventListener('click',   () => add(inputEl.value));
    inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') add(inputEl.value); });
    clearBtn.addEventListener('click', clearDone);
    document.querySelectorAll('.filter-tab').forEach(btn =>
      btn.addEventListener('click', () => setFilter(btn.dataset.filter))
    );
  }

  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  return { init };
})();


/* ================================================================
   SETTINGS SYSTEM
================================================================ */
const SETTINGS_SYSTEM = (() => {

  /* Cached settings */
  const prefs = {
    sound: 'bell', alarmVol: 0.7, musicVol: 0.6,
    muted: false, autoStart: false, notifications: false,
  };

  function load() {
    try {
      const raw = localStorage.getItem('pomodoroPrefs');
      if (raw) Object.assign(prefs, JSON.parse(raw));
    } catch(_) {}
    applyToAudio();
  }

  function save() {
    try { localStorage.setItem('pomodoroPrefs', JSON.stringify(prefs)); } catch(_) {}
  }

  function applyToAudio() {
    AUDIO_SYSTEM.setAlarmVolume(prefs.alarmVol);
    AUDIO_SYSTEM.setMusicVolume(prefs.musicVol);
    AUDIO_SYSTEM.setMuted(prefs.muted);
  }

  function populateForm() {
    document.getElementById('soundSelect').value  = prefs.sound;
    document.getElementById('alarmVolume').value  = prefs.alarmVol;
    document.getElementById('musicVolume').value  = prefs.musicVol;
    document.getElementById('muteToggle').checked = prefs.muted;
    document.getElementById('autoStart').checked  = prefs.autoStart;
    document.getElementById('browserNotif').checked = prefs.notifications;
  }

  function readForm() {
    prefs.sound         = document.getElementById('soundSelect').value;
    prefs.alarmVol      = parseFloat(document.getElementById('alarmVolume').value);
    prefs.musicVol      = parseFloat(document.getElementById('musicVolume').value);
    prefs.muted         = document.getElementById('muteToggle').checked;
    prefs.autoStart     = document.getElementById('autoStart').checked;
    prefs.notifications = document.getElementById('browserNotif').checked;
  }

  function open() {
    populateForm();
    document.getElementById('settingsDrawer').classList.add('open');
    document.getElementById('drawerOverlay').classList.add('open');
  }

  function close() {
    document.getElementById('settingsDrawer').classList.remove('open');
    document.getElementById('drawerOverlay').classList.remove('open');
  }

  function apply() {
    readForm();
    save();
    applyToAudio();
    if (prefs.notifications && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    close();
  }

  const getPrefs = () => prefs;

  function init() {
    load();

    document.getElementById('openDrawer').addEventListener('click', open);
    document.getElementById('closeDrawer').addEventListener('click', close);
    document.getElementById('drawerOverlay').addEventListener('click', close);
    document.getElementById('saveDrawer').addEventListener('click', apply);

    /* Music file inputs */
    document.querySelectorAll('[id^="musicFile-"]').forEach(input => {
      input.addEventListener('change', e => {
        const session = e.target.dataset.session;
        const file    = e.target.files[0];
        if (file && session) {
          AUDIO_SYSTEM.loadMusicFile(session, file);
          e.target.value = '';
        }
      });
    });

    /* Music remove buttons */
    document.querySelectorAll('.rm-music').forEach(btn => {
      btn.addEventListener('click', () => AUDIO_SYSTEM.removeMusicTrack(btn.dataset.session));
    });

    /* Now-playing stop button */
    document.getElementById('npStop').addEventListener('click', () => AUDIO_SYSTEM.stopAllMusic());

    /* Escape key closes drawer */
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && document.getElementById('settingsDrawer').classList.contains('open')) close();
    });
  }

  return { init, getPrefs };
})();


/* ================================================================
   THEME SYSTEM
================================================================ */
const THEME_SYSTEM = (() => {
  const btn  = document.getElementById('themeBtn');
  const icon = document.getElementById('themeIcon');
  const root = document.documentElement;

  function set(mode) {
    root.setAttribute('data-theme', mode);
    icon.textContent = mode === 'dark' ? '☀️' : '🌙';
    try { localStorage.setItem('pomodoroTheme', mode); } catch(_) {}
  }

  function init() {
    try { const s = localStorage.getItem('pomodoroTheme'); if (s) set(s); } catch(_) {}
    btn.addEventListener('click', () =>
      set(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark')
    );
  }
  return { init };
})();


/* ================================================================
   MAIN EVENT WIRING
   ================================================================
   Connects the six systems together.
   All DOM event listeners for timer controls are set here.
================================================================ */
function wireEvents() {

  /* ── Timer System callbacks ── */

  /**
   * onTick: fires every ~250ms.
   * Updates the display for whichever session fired the tick.
   */
  TIMER_SYSTEM.onTick((session, timeLeft, total) => {
    LAYOUT_SYSTEM.updateDisplay(session, timeLeft, total);
    LAYOUT_SYSTEM.syncPlayPauseIcons();
  });

  /**
   * onComplete: fires when a timer reaches zero.
   * Handles: alarm, notification banner, auto-advance to next session.
   */
  TIMER_SYSTEM.onComplete((session, silent) => {
    const next = TIMER_SYSTEM.getNextSession(session);

    if (!silent) {
      const { sound } = SETTINGS_SYSTEM.getPrefs();
      AUDIO_SYSTEM.playAlarm(sound);
      LAYOUT_SYSTEM.flashArc(session);
      LAYOUT_SYSTEM.shakeCard(session);
    }

    NOTIF_SYSTEM.show(session, next);
    AUDIO_SYSTEM.stopAllMusic();

    LAYOUT_SYSTEM.updateCycleDots();
    LAYOUT_SYSTEM.updateStats();

    setTimeout(() => {
      TIMER_SYSTEM.reset(next);
      LAYOUT_SYSTEM.switchActive(next);

      const { autoStart } = SETTINGS_SYSTEM.getPrefs();
      if (autoStart) {
        TIMER_SYSTEM.start(next);
        AUDIO_SYSTEM.playSesssionMusic(next);
        LAYOUT_SYSTEM.syncPlayPauseIcons();
      }
    }, 700);
  });

  /* ── WORK card controls (main #resetBtn, #playPauseBtn, #skipBtn) ── */
  document.getElementById('playPauseBtn').addEventListener('click', () => {
    handlePlayPause('work');
  });
  document.getElementById('resetBtn').addEventListener('click', () => {
    TIMER_SYSTEM.reset('work');
    AUDIO_SYSTEM.stopAllMusic();
    LAYOUT_SYSTEM.syncPlayPauseIcons();
  });
  document.getElementById('skipBtn').addEventListener('click', () => {
    TIMER_SYSTEM.skip('work');
  });

  /* ── SHORT BREAK + LONG BREAK card controls (data-* buttons) ── */
  ['shortBreak', 'longBreak'].forEach(session => {
    document.querySelector(`[data-playpause="${session}"]`)?.addEventListener('click', () => {
      handlePlayPause(session);
    });
    document.querySelector(`[data-reset="${session}"]`)?.addEventListener('click', () => {
      TIMER_SYSTEM.reset(session);
      AUDIO_SYSTEM.stopAllMusic();
      LAYOUT_SYSTEM.syncPlayPauseIcons();
    });
    document.querySelector(`[data-skip="${session}"]`)?.addEventListener('click', () => {
      TIMER_SYSTEM.skip(session);
    });
  });

  /**
   * Shared play/pause logic.
   * If the session is not currently the active (hero) card,
   * switch it to center first, then start.
   */
  function handlePlayPause(session) {
    if (LAYOUT_SYSTEM.getActive() !== session) {
      /* Activate this session (move to center) and start it */
      LAYOUT_SYSTEM.switchActive(session, true);
    } else {
      /* Already active: toggle play/pause */
      TIMER_SYSTEM.togglePlayPause(session);
      if (TIMER_SYSTEM.getRunning() === session) {
        AUDIO_SYSTEM.playSesssionMusic(session);
      } else {
        AUDIO_SYSTEM.stopAllMusic();
      }
      LAYOUT_SYSTEM.syncPlayPauseIcons();
    }
  }

  /* ── Side-card "Start" buttons (activate + start) ── */
  document.querySelectorAll('.sf-activate-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const session = btn.dataset.activate;
      LAYOUT_SYSTEM.switchActive(session, /* andStart */ true);
      LAYOUT_SYSTEM.syncPlayPauseIcons();
    });
  });

  /* ── Editable duration inputs (side cards) ──
     Changing the input updates the timer's duration.
     If the timer is not running: also resets its timeLeft.
  */
  document.querySelectorAll('.sf-duration-input').forEach(input => {
    input.addEventListener('change', () => {
      const session = input.dataset.durationSession;
      const mins    = parseInt(input.value, 10);
      if (!isNaN(mins)) {
        TIMER_SYSTEM.setDuration(session, mins);
        const s = TIMER_SYSTEM.getState(session);
        LAYOUT_SYSTEM.updateDisplay(session, s.timeLeft, s.durationSecs);
      }
    });
  });

  /* Focus input in hero card → track current task */
  const focusInput = document.getElementById('focusInput');
  if (focusInput) {
    focusInput.addEventListener('input', e => {
      /* Could be used for history logging etc. */
      void e;
    });
  }

  /* Space bar = play/pause active session */
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      handlePlayPause(LAYOUT_SYSTEM.getActive());
    }
  });
}


/* ================================================================
   INIT
================================================================ */
function init() {
  /* 1. Load persisted data */
  TIMER_SYSTEM.loadStats();
  SETTINGS_SYSTEM.init();
  THEME_SYSTEM.init();

  /* 2. Set initial active card (work = center) */
  document.getElementById('card-work').classList.add('active');
  document.getElementById('timersArena').setAttribute('data-active', 'work');

  /* Make work's active-face and other cards' side-faces visible */
  document.querySelectorAll('.timer-card').forEach(card => {
    const session = card.dataset.session;
    const af = card.querySelector('.active-face');
    const sf = card.querySelector('.side-face');
    af.setAttribute('aria-hidden', session !== 'work');
    sf.setAttribute('aria-hidden', session === 'work');
  });

  /* 3. Initial display sync for all three timers */
  ['work', 'shortBreak', 'longBreak'].forEach(session => {
    const s = TIMER_SYSTEM.getState(session);
    LAYOUT_SYSTEM.updateDisplay(session, s.timeLeft, s.durationSecs);
  });

  LAYOUT_SYSTEM.updateCycleDots();
  LAYOUT_SYSTEM.updateStats();

  /* 4. Wire events */
  wireEvents();

  /* 5. Init task system */
  TASK_SYSTEM.init();

  console.log('%c🍅 Pomodoro v3 – Ready', 'color:#e8933a;font-weight:bold;font-size:14px');
}

document.addEventListener('DOMContentLoaded', init);