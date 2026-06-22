/**
 * WMMF SCOREBOARD — app.js
 * State Manager · Clock Engine · Cross-Tab Sync · PDF Export
 */

/* ============================================================
   CONSTANTS
   ============================================================ */
const STATE_KEY = 'wmmf_state';
const CHANNEL_NAME = 'wmmf_sync';
const MATCH_CLOCK_DEFAULT = 10 * 60;  // 10:00
const PENALTY_CLOCK_DEFAULT = 2 * 60;  //  2:00
const MAX_FOULS = 8;        // per player
const MAX_TEAM_FOULS = 10;       // per team
const MAX_PLAYERS = 8;        // per roster
const MAX_TIMEOUTS = 3;
const SPP_SECONDS = 30;
const LPP_SECONDS = 60;
// Unique client id to avoid processing our own BroadcastChannel messages
const _CLIENT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/* ============================================================
   DEFAULT STATE
   ============================================================ */
function defaultState() {
  return {
    homeTeam: {
      name: 'HOME TEAM',
      score: 0,
      timeouts: 3,
      fouls: 0,
      penalty: 'NONE',
      roster: []
    },
    awayTeam: {
      name: 'AWAY TEAM',
      score: 0,
      timeouts: 3,
      fouls: 0,
      penalty: 'NONE',
      roster: []
    },
    matchClock: {
      seconds: MATCH_CLOCK_DEFAULT,
      running: false
    },
    selectedMatchDuration: MATCH_CLOCK_DEFAULT,
    // Twin independent penalty clocks — one per team
    homePenaltyClock: {
      seconds: 0,
      running: false,
      queue: []          // array of seconds to countdown sequentially
    },
    awayPenaltyClock: {
      seconds: 0,
      running: false,
      queue: []
    },
    dotMode: 'dots',          // 'dots' | 'numeric'
    matchHistory: [],
    lastUpdated: Date.now()
  };
}

/* ============================================================
   STATE MANAGER
   ============================================================ */
const StateManager = (() => {
  let _state = null;
  let _listeners = [];
  let _channel = null;

  function _load() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      _state = raw ? JSON.parse(raw) : defaultState();
    } catch {
      _state = defaultState();
    }
  }

  function _save(patch) {
    _state = { ..._state, ...patch, lastUpdated: Date.now() };
    localStorage.setItem(STATE_KEY, JSON.stringify(_state));
    // Broadcast to other tabs/contexts (storage event won't fire in originating tab)
    try {
      _channel?.postMessage({ type: 'STATE_UPDATE', state: _state, clientId: _CLIENT_ID });
    } catch (e) { /* ignore */ }
    _notify();
  }

  function _notify() {
    _listeners.forEach(fn => fn(_state));
  }

  function init() {
    _load();

    // BroadcastChannel for same-origin cross-tab (instant)
    if (typeof BroadcastChannel !== 'undefined') {
      _channel = new BroadcastChannel(CHANNEL_NAME);
      _channel.onmessage = (e) => {
        // Ignore messages we originated to avoid double-processing in this tab
        if (e.data?.type === 'STATE_UPDATE' && e.data?.clientId !== _CLIENT_ID) {
          _state = e.data.state;
          _notify();
        }
      };
    }

    // storage event fires in OTHER tabs when localStorage changes
    window.addEventListener('storage', (e) => {
      if (e.key === STATE_KEY && e.newValue) {
        try {
          _state = JSON.parse(e.newValue);
          _notify();
        } catch { /* ignore */ }
      }
    });
  }

  function getState() { return _state; }

  function subscribe(fn) {
    _listeners.push(fn);
    fn(_state); // immediate call with current state
    return () => { _listeners = _listeners.filter(l => l !== fn); };
  }

  function update(patch) { _save(patch); }

  function resetAll() {
    const fresh = defaultState();
    fresh.dotMode = _state.dotMode; // preserve display mode
    _save(fresh);
  }

  return { init, getState, subscribe, update, resetAll };
})();

/* ============================================================
   CLOCK ENGINE
   ============================================================ */
const ClockEngine = (() => {
  let matchInterval = null;
  let homePenaltyInterval = null;
  let awayPenaltyInterval = null;

  // ── Match clock tick ────────────────────────────────────
  function _tickMatch() {
    const s = StateManager.getState();
    const clock = s.matchClock;
    if (!clock.running) return;
    const newSec = clock.seconds - 1;
    if (newSec <= 0) {
      clearInterval(matchInterval); matchInterval = null;
      StateManager.update({ matchClock: { seconds: 0, running: false } });
      _logEvent('Match clock ended');
      return;
    }
    StateManager.update({ matchClock: { ...clock, seconds: newSec } });
  }

  // ── Penalty clock tick (with queue drain) ───────────────
  function _tickPenalty(clockKey) {
    const s = StateManager.getState();
    const clock = s[clockKey];
    if (!clock.running) return;
    const newSec = clock.seconds - 1;
    if (newSec <= 0) {
      // Try to dequeue next penalty
      const queue = [...(clock.queue || [])];
      if (queue.length > 0) {
        const next = queue.shift();
        StateManager.update({ [clockKey]: { ...clock, seconds: next, running: true, queue } });
      } else {
        StateManager.update({ [clockKey]: { ...clock, seconds: 0, running: false, queue: [] } });
        _logEvent(`${clockKey === 'homePenaltyClock' ? 'Home' : 'Away'} penalty ended`);
      }
      return;
    }
    StateManager.update({ [clockKey]: { ...clock, seconds: newSec } });
  }

  // ── Match clock controls ────────────────────────────────
  function startMatch() {
    const s = StateManager.getState();
    if (s.matchClock.running) return;
    // Guard: clear any stale interval before creating a new one
    if (matchInterval) { clearInterval(matchInterval); matchInterval = null; }
    // Create the interval first, then flip state.running to true to avoid
    // render subscribers creating a second interval (race condition).
    matchInterval = setInterval(_tickMatch, 1000);
    StateManager.update({ matchClock: { ...s.matchClock, running: true } });
  }
  function stopMatch() {
    clearInterval(matchInterval); matchInterval = null;
    const s = StateManager.getState();
    StateManager.update({ matchClock: { ...s.matchClock, running: false } });
  }
  function resetMatch() {
    stopMatch();
    const s = StateManager.getState();
    StateManager.update({ matchClock: { seconds: s.selectedMatchDuration, running: false } });
  }
  function toggleMatch() {
    const s = StateManager.getState();
    if (s.matchClock.running) stopMatch(); else startMatch();
  }

  // ── Generic penalty clock start ─────────────────────────
  function _startPenaltyClock(clockKey) {
    // Guard: clear any existing interval before starting a new one
    if (clockKey === 'homePenaltyClock') {
      if (homePenaltyInterval) { clearInterval(homePenaltyInterval); homePenaltyInterval = null; }
    } else {
      if (awayPenaltyInterval) { clearInterval(awayPenaltyInterval); awayPenaltyInterval = null; }
    }
    // Create interval first, then update state.running. This prevents a
    // render subscriber (which calls syncFromState) from seeing running=true
    // while our local interval variable is still null and creating a duplicate.
    if (clockKey === 'homePenaltyClock') {
      if (!homePenaltyInterval) homePenaltyInterval = setInterval(() => _tickPenalty(clockKey), 1000);
    } else {
      if (!awayPenaltyInterval) awayPenaltyInterval = setInterval(() => _tickPenalty(clockKey), 1000);
    }
    const s = StateManager.getState();
    StateManager.update({ [clockKey]: { ...s[clockKey], running: true } });
  }
  function _stopPenaltyClock(clockKey) {
    if (clockKey === 'homePenaltyClock') { clearInterval(homePenaltyInterval); homePenaltyInterval = null; }
    else { clearInterval(awayPenaltyInterval); awayPenaltyInterval = null; }
    const s = StateManager.getState();
    StateManager.update({ [clockKey]: { ...s[clockKey], running: false } });
  }
  function _resetPenaltyClock(clockKey) {
    _stopPenaltyClock(clockKey);
    StateManager.update({ [clockKey]: { seconds: 0, running: false, queue: [] } });
  }

  // ── Public penalty clock API ────────────────────────────
  function toggleHomePenalty() {
    const s = StateManager.getState();
    if (s.homePenaltyClock.running) _stopPenaltyClock('homePenaltyClock');
    else if (s.homePenaltyClock.seconds > 0) _startPenaltyClock('homePenaltyClock');
  }
  function toggleAwayPenalty() {
    const s = StateManager.getState();
    if (s.awayPenaltyClock.running) _stopPenaltyClock('awayPenaltyClock');
    else if (s.awayPenaltyClock.seconds > 0) _startPenaltyClock('awayPenaltyClock');
  }
  function resetHomePenalty() { _resetPenaltyClock('homePenaltyClock'); }
  function resetAwayPenalty() { _resetPenaltyClock('awayPenaltyClock'); }

  // ── Push seconds onto a team's penalty clock queue ──────
  function pushPenalty(clockKey, seconds) {
    const s = StateManager.getState();
    const clock = s[clockKey];
    if (clock.running || clock.seconds > 0) {
      // Append to queue
      const queue = [...(clock.queue || []), seconds];
      StateManager.update({ [clockKey]: { ...clock, queue } });
    } else {
      // Clock is idle — set seconds first (but NOT running:true yet,
      // to prevent syncFromState from racing _startPenaltyClock and
      // creating a duplicate interval).
      StateManager.update({ [clockKey]: { seconds, running: false, queue: [] } });
      _startPenaltyClock(clockKey);
    }
  }

  // ── Sync running state from external tab ────────────────
  function syncFromState(state) {
    // Match clock — only manage interval, never stack duplicates
    if (state.matchClock.running && !matchInterval) {
      matchInterval = setInterval(_tickMatch, 1000);
    } else if (!state.matchClock.running && matchInterval) {
      clearInterval(matchInterval); matchInterval = null;
    }
    // Home penalty clock
    if (state.homePenaltyClock.running && !homePenaltyInterval) {
      homePenaltyInterval = setInterval(() => _tickPenalty('homePenaltyClock'), 1000);
    } else if (!state.homePenaltyClock.running && homePenaltyInterval) {
      clearInterval(homePenaltyInterval); homePenaltyInterval = null;
    }
    // Away penalty clock
    if (state.awayPenaltyClock.running && !awayPenaltyInterval) {
      awayPenaltyInterval = setInterval(() => _tickPenalty('awayPenaltyClock'), 1000);
    } else if (!state.awayPenaltyClock.running && awayPenaltyInterval) {
      clearInterval(awayPenaltyInterval); awayPenaltyInterval = null;
    }
  }

  return {
    toggleMatch, resetMatch,
    toggleHomePenalty, toggleAwayPenalty,
    resetHomePenalty, resetAwayPenalty,
    pushPenalty, syncFromState
  };
})();

/* ============================================================
   HELPERS
   ============================================================ */
function formatTime(totalSeconds) {
  const m = Math.floor(Math.max(0, totalSeconds) / 60);
  const s = Math.max(0, totalSeconds) % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function setTextIfChanged(el, text) {
  if (el && el.textContent !== text) {
    el.textContent = text;
  }
}

function setValueIfChanged(el, value) {
  if (el && el.value !== value) {
    el.value = value;
  }
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function _logEvent(msg) {
  const s = StateManager.getState();
  const entry = {
    id: uid(),
    time: formatTime(s.matchClock.seconds),
    event: msg,
    home: s.homeTeam.score,
    away: s.awayTeam.score,
    timestamp: new Date().toLocaleTimeString()
  };
  StateManager.update({ matchHistory: [...s.matchHistory, entry] });
}

/* ============================================================
   SCORE ACTIONS
   ============================================================ */
function changeScore(team, delta) {
  const s = StateManager.getState();
  const t = s[team];
  const newScore = Math.max(0, t.score + delta);
  StateManager.update({ [team]: { ...t, score: newScore } });
  if (delta > 0) _logEvent(`${t.name} scored! (${newScore})`);
}

function changeTimeout(team, delta) {
  const s = StateManager.getState();
  const t = s[team];
  const val = Math.min(MAX_TIMEOUTS, Math.max(0, t.timeouts + delta));
  StateManager.update({ [team]: { ...t, timeouts: val } });
}

function changePenalty(team, value) {
  const s = StateManager.getState();
  const t = s[team];
  StateManager.update({ [team]: { ...t, penalty: value } });
}

function updateMatchDuration(value) {
  const minutes = parseInt(value, 10);
  if (![8, 10].includes(minutes)) return;
  const seconds = minutes * 60;
  const s = StateManager.getState();
  const update = { selectedMatchDuration: seconds };
  if (!s.matchClock.running) {
    update.matchClock = { ...s.matchClock, seconds };
  }
  StateManager.update(update);
}

function confirmMatchReset() {
  const s = StateManager.getState();
  const resetLabel = formatTime(s.selectedMatchDuration);
  const doReset = () => ClockEngine.resetMatch();
  if (typeof window.confirmAction === 'function') {
    window.confirmAction(`Reset match clock to ${resetLabel}?`, doReset);
  } else if (confirm(`Reset match clock to ${resetLabel}?`)) {
    doReset();
  }
}

/* ============================================================
   ROSTER ACTIONS
   ============================================================ */
function addPlayer(team) {
  const s = StateManager.getState();
  const t = s[team];
  if (t.roster.length >= MAX_PLAYERS) {
    alert(`Roster limit reached: maximum ${MAX_PLAYERS} players per team.`);
    return;
  }
  const newPlayer = { id: uid(), name: `Player ${t.roster.length + 1}`, fouls: 0 };
  StateManager.update({ [team]: { ...t, roster: [...t.roster, newPlayer] } });
}

function updatePlayerName(team, playerId, name) {
  const s = StateManager.getState();
  const t = s[team];
  const roster = t.roster.map(p => p.id === playerId ? { ...p, name } : p);
  StateManager.update({ [team]: { ...t, roster } });
}

function changeFoul(team, playerId, delta) {
  const s = StateManager.getState();
  const t = s[team];
  // Enforce team foul cap of MAX_TEAM_FOULS
  if (delta > 0 && t.fouls >= MAX_TEAM_FOULS) return;
  let totalFouls = t.fouls;
  const roster = t.roster.map(p => {
    if (p.id !== playerId) return p;
    const newF = Math.min(MAX_FOULS, Math.max(0, p.fouls + delta));
    totalFouls += (newF - p.fouls);
    return { ...p, fouls: newF };
  });
  totalFouls = Math.min(MAX_TEAM_FOULS, Math.max(0, totalFouls));
  StateManager.update({ [team]: { ...t, roster, fouls: totalFouls } });
  if (delta > 0) _logEvent(`Foul on ${t.name}`);
}

function deletePlayer(team, playerId) {
  const s = StateManager.getState();
  const t = s[team];
  const player = t.roster.find(p => p.id === playerId);
  const playerName = player ? player.name : 'this player';

  // Use styled dialog if available, otherwise native confirm
  const doDelete = () => {
    const s2 = StateManager.getState();
    const t2 = s2[team];
    const roster = t2.roster.filter(p => p.id !== playerId);
    const fouls = Math.max(0, t2.fouls - (player?.fouls || 0));
    StateManager.update({ [team]: { ...t2, roster, fouls } });
  };

  if (typeof window.confirmAction === 'function') {
    window.confirmAction(`Remove ${playerName} from the roster?`, doDelete);
  } else {
    if (confirm(`Remove ${playerName} from the roster?`)) doDelete();
  }
}

/**
 * triggerPenalty — called when admin picks SPP or LPP from dialog.
 * @param {string} team        'homeTeam' | 'awayTeam'
 * @param {string} playerId    player UUID
 * @param {'SPP'|'LPP'} type  Short (30s) or Long (60s) Penalty
 */
function triggerPenalty(team, playerId, type) {
  const s = StateManager.getState();
  const t = s[team];

  // Enforce foul limits before adding
  if (t.fouls >= MAX_TEAM_FOULS) {
    alert(`Team foul limit (${MAX_TEAM_FOULS}) reached.`);
    return;
  }

  const seconds = type === 'SPP' ? SPP_SECONDS : LPP_SECONDS;
  const player = t.roster.find(p => p.id === playerId);
  if (!player) return;

  // Increment player foul count (capped at MAX_FOULS)
  const newPlayerFouls = Math.min(MAX_FOULS, player.fouls + 1);
  const foulDelta = newPlayerFouls - player.fouls;
  const newTeamFouls = Math.min(MAX_TEAM_FOULS, t.fouls + foulDelta);
  const roster = t.roster.map(p =>
    p.id === playerId ? { ...p, fouls: newPlayerFouls } : p
  );
  StateManager.update({ [team]: { ...t, roster, fouls: newTeamFouls } });

  // Push seconds onto the correct team's penalty clock
  const clockKey = team === 'homeTeam' ? 'homePenaltyClock' : 'awayPenaltyClock';
  ClockEngine.pushPenalty(clockKey, seconds);

  // Sync to card tracking lists (SPP -> Blue, LPP -> Red)
  if (typeof window !== 'undefined' && typeof window.addCardForPlayer === 'function') {
    const teamKey = team === 'homeTeam' ? 'home' : 'away';
    const cardType = type === 'SPP' ? 'blue' : 'red';
    window.addCardForPlayer(teamKey, playerId, cardType);
  }

  _logEvent(`${player.name} — ${type} (${seconds}s) on ${t.name}`);
}

/* ============================================================
   PDF EXPORT
   ============================================================ */
async function exportPDF() {
  // Dynamically load jsPDF from CDN
  if (!window.jspdf) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const s = StateManager.getState();
  const now = new Date().toLocaleString();
  const pageW = doc.internal.pageSize.getWidth();

  // ── Header ──
  doc.setFillColor(17, 18, 20);
  doc.rect(0, 0, pageW, 30, 'F');
  doc.setTextColor(0, 200, 255);
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('WMMF MATCHUP MATCH CLOCK', 14, 13);
  doc.setTextColor(150, 150, 150);
  doc.setFontSize(8);
  doc.text('LIVE STREAM SCOREBOARD — MATCH REPORT', 14, 19);
  doc.text(`Generated: ${now}`, pageW - 14, 19, { align: 'right' });

  // ── Score Summary ──
  let y = 38;
  doc.setFillColor(28, 30, 34);
  doc.roundedRect(10, y, pageW - 20, 28, 3, 3, 'F');
  doc.setTextColor(0, 200, 255);
  doc.setFontSize(20); doc.setFont('helvetica', 'bold');
  doc.text(String(s.homeTeam.score), 40, y + 18, { align: 'center' });
  doc.setTextColor(255, 140, 0);
  doc.text(String(s.awayTeam.score), pageW - 40, y + 18, { align: 'center' });
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(10);
  doc.text(s.homeTeam.name, 40, y + 7, { align: 'center' });
  doc.text(s.awayTeam.name, pageW - 40, y + 7, { align: 'center' });
  doc.setTextColor(57, 255, 20);
  doc.setFontSize(14);
  doc.text(formatTime(s.matchClock.seconds), pageW / 2, y + 15, { align: 'center' });
  doc.setTextColor(150, 150, 150);
  doc.setFontSize(7);
  doc.text('MATCH CLOCK', pageW / 2, y + 21, { align: 'center' });

  // ── Stats row ──
  y += 36;
  doc.setFontSize(9); doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 100, 100);
  doc.text(`Timeouts Left: ${s.homeTeam.timeouts}`, 14, y);
  doc.text(`Team Fouls: ${s.homeTeam.fouls}`, 14, y + 5);
  doc.text(`Penalty: ${s.homeTeam.penalty}`, 14, y + 10);
  doc.text(`Timeouts Left: ${s.awayTeam.timeouts}`, pageW - 14, y, { align: 'right' });
  doc.text(`Team Fouls: ${s.awayTeam.fouls}`, pageW - 14, y + 5, { align: 'right' });
  doc.text(`Penalty: ${s.awayTeam.penalty}`, pageW - 14, y + 10, { align: 'right' });

  // ── Match History ──
  y += 22;
  doc.setDrawColor(40, 40, 40);
  doc.line(14, y, pageW - 14, y);
  y += 6;
  doc.setTextColor(0, 200, 255);
  doc.setFontSize(11); doc.setFont('helvetica', 'bold');
  doc.text('MATCH HISTORY LOG', 14, y);
  y += 6;

  const history = s.matchHistory;
  if (history.length === 0) {
    doc.setTextColor(100, 100, 100);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.text('No events logged yet.', 14, y + 5);
  } else {
    // Table header
    doc.setFillColor(28, 30, 34);
    doc.rect(10, y, pageW - 20, 7, 'F');
    doc.setTextColor(150, 150, 150);
    doc.setFontSize(8); doc.setFont('helvetica', 'bold');
    doc.text('#', 15, y + 5);
    doc.text('TIME', 25, y + 5);
    doc.text('EVENT', 50, y + 5);
    doc.text('HOME', pageW - 50, y + 5, { align: 'right' });
    doc.text('AWAY', pageW - 15, y + 5, { align: 'right' });
    y += 7;

    doc.setFont('helvetica', 'normal');
    history.forEach((entry, i) => {
      if (y > 270) {
        doc.addPage();
        y = 20;
      }
      const rowBg = i % 2 === 0 ? [20, 21, 24] : [24, 26, 30];
      doc.setFillColor(...rowBg);
      doc.rect(10, y - 1, pageW - 20, 6, 'F');
      doc.setTextColor(200, 200, 200);
      doc.text(String(i + 1), 15, y + 4);
      doc.setTextColor(57, 255, 20);
      doc.text(entry.time, 25, y + 4);
      doc.setTextColor(200, 200, 200);
      doc.text(entry.event, 50, y + 4);
      doc.setTextColor(0, 200, 255);
      doc.text(String(entry.home), pageW - 50, y + 4, { align: 'right' });
      doc.setTextColor(255, 140, 0);
      doc.text(String(entry.away), pageW - 15, y + 4, { align: 'right' });
      y += 6;
    });
  }

  // ── Roster Tables ──
  [
    { team: s.homeTeam, color: [0, 200, 255] },
    { team: s.awayTeam, color: [255, 140, 0] }
  ].forEach(({ team, color }) => {
    if (team.roster.length === 0) return;
    if (y > 240) { doc.addPage(); y = 20; }
    y += 8;
    doc.line(14, y, pageW - 14, y);
    y += 6;
    doc.setTextColor(...color);
    doc.setFontSize(10); doc.setFont('helvetica', 'bold');
    doc.text(`${team.name} — ROSTER`, 14, y);
    y += 5;
    doc.setFillColor(28, 30, 34);
    doc.rect(10, y, pageW - 20, 6, 'F');
    doc.setTextColor(150, 150, 150);
    doc.setFontSize(8);
    doc.text('PLAYER', 15, y + 4);
    doc.text('FOULS', pageW - 15, y + 4, { align: 'right' });
    y += 6;
    team.roster.forEach((p, i) => {
      const rowBg = i % 2 === 0 ? [20, 21, 24] : [24, 26, 30];
      doc.setFillColor(...rowBg);
      doc.rect(10, y - 1, pageW - 20, 5, 'F');
      doc.setTextColor(200, 200, 200);
      doc.text(`P${i + 1}  ${p.name}`, 15, y + 3);
      doc.setTextColor(255, 59, 59);
      doc.text(String(p.fouls), pageW - 15, y + 3, { align: 'right' });
      y += 5;
    });
  });

  // ── Footer ──
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setTextColor(60, 60, 60);
    doc.setFontSize(7);
    doc.text(`WMMF SCOREBOARD © ${new Date().getFullYear()} — Page ${i} of ${pageCount}`, pageW / 2, 290, { align: 'center' });
  }

  doc.save(`wmmf-match-report-${Date.now()}.pdf`);
}

/* ============================================================
   ADMIN PAGE — RENDER
   ============================================================ */
function renderAdmin(state) {
  // ── Header sync badge ──
  if (adminEls['live-badge']) {
    adminEls['live-badge'].title = `Last updated: ${new Date(state.lastUpdated).toLocaleTimeString()}`;
  }

  // ── Toggle Mode ──
  adminEls['toggle-dots']?.classList.toggle('active', state.dotMode === 'dots');
  adminEls['toggle-numeric']?.classList.toggle('active', state.dotMode === 'numeric');

  // ── Home Team ──
  if (adminEls['home-name'] && document.activeElement !== adminEls['home-name']) {
    adminEls['home-name'].value = state.homeTeam.name;
  }
  setTextIfChanged(adminEls['home-score'], state.homeTeam.score);
  setTextIfChanged(adminEls['home-timeouts-val'], state.homeTeam.timeouts);
  setValueIfChanged(adminEls['home-penalty'], state.homeTeam.penalty);

  // ── Away Team ──
  if (adminEls['away-name'] && document.activeElement !== adminEls['away-name']) {
    adminEls['away-name'].value = state.awayTeam.name;
  }
  setTextIfChanged(adminEls['away-score'], state.awayTeam.score);
  setTextIfChanged(adminEls['away-timeouts-val'], state.awayTeam.timeouts);
  setValueIfChanged(adminEls['away-penalty'], state.awayTeam.penalty);

  // ── Match Clock ──
  setTextIfChanged(adminEls['match-clock-display'], formatTime(state.matchClock.seconds));
  setValueIfChanged(adminEls['match-duration-select'], String(state.selectedMatchDuration / 60));
  const matchBtn = adminEls['match-clock-btn'];
  if (matchBtn) {
    const btnText = state.matchClock.running ? '⏸ PAUSE TIMER' : '▶ START TIMER';
    if (matchBtn.textContent !== btnText) matchBtn.textContent = btnText;
    matchBtn.classList.toggle('running', state.matchClock.running);
  }

  // ── Home Penalty Clock ──
  const hpc = state.homePenaltyClock || { seconds: 0, running: false, queue: [] };
  setTextIfChanged(adminEls['home-penalty-clock-display'], formatTime(hpc.seconds));
  const hPenBtn = adminEls['home-penalty-clock-btn'];
  if (hPenBtn) {
    const inner = hpc.running
      ? `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><polygon points="5,3 19,12 5,21"/></svg>`;
    if (hPenBtn.innerHTML !== inner) hPenBtn.innerHTML = inner;
    hPenBtn.classList.toggle('running', hpc.running);
  }
  const hQueueEl = adminEls['home-penalty-queue'];
  if (hQueueEl) {
    const q = hpc.queue || [];
    setTextIfChanged(hQueueEl, q.length > 0 ? `+${q.length} queued` : '');
  }

  // ── Home roster / penalty labels ──
  setTextIfChanged(adminEls['home-roster-title'], state.homeTeam.name);
  setTextIfChanged(adminEls['home-roster-penalty'], state.homeTeam.name);

  // ── Away roster / penalty labels ──
  setTextIfChanged(adminEls['away-roster-title'], state.awayTeam.name);
  setTextIfChanged(adminEls['away-roster-penalty'], state.awayTeam.name);

  // ── Away Penalty Clock ──
  const apc = state.awayPenaltyClock || { seconds: 0, running: false, queue: [] };
  setTextIfChanged(adminEls['away-penalty-clock-display'], formatTime(apc.seconds));
  const aPenBtn = adminEls['away-penalty-clock-btn'];
  if (aPenBtn) {
    const inner = apc.running
      ? `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><polygon points="5,3 19,12 5,21"/></svg>`;
    if (aPenBtn.innerHTML !== inner) aPenBtn.innerHTML = inner;
    aPenBtn.classList.toggle('running', apc.running);
  }
  const aQueueEl = adminEls['away-penalty-queue'];
  if (aQueueEl) {
    const q = apc.queue || [];
    setTextIfChanged(aQueueEl, q.length > 0 ? `+${q.length} queued` : '');
  }

  // Sync clock intervals from external state
  ClockEngine.syncFromState(state);

  // ── Rosters ──
  renderRoster('home', state);
  renderRoster('away', state);
}

function renderRoster(team, state) {
  const t = state[`${team}Team`];
  const container = document.getElementById(`${team}-roster-list`);
  if (!container) return;

  // Update fouls badge
  const foulsBadge = document.getElementById(`${team}-fouls-count`);
  if (foulsBadge) foulsBadge.textContent = t.fouls;

  const isDots = state.dotMode === 'dots';
  const dotClass = team === 'home' ? 'home-dot' : 'away-dot';

  // Preserve focused element
  const focusedId = document.activeElement?.dataset?.playerId;

  // Show roster limit indicator
  const addBtn = document.querySelector(`[onclick="addPlayer('${team}Team')"]`);
  if (addBtn) {
    const atLimit = t.roster.length >= MAX_PLAYERS;
    addBtn.disabled = atLimit;
    addBtn.style.opacity = atLimit ? '0.35' : '1';
    addBtn.title = atLimit ? `Max ${MAX_PLAYERS} players reached` : 'Add player';
  }
  // Show team foul limit indicator
  const foulBadgeEl = document.getElementById(`${team}-fouls-count`);
  if (foulBadgeEl) {
    foulBadgeEl.style.color = t.fouls >= MAX_TEAM_FOULS ? 'var(--penalty)' : '';
    foulBadgeEl.textContent = `${t.fouls}/${MAX_TEAM_FOULS}`;
  }

  // ── DOM-diff roster: only add/remove/update rows, don't rebuild ──
  const existingRows = container.querySelectorAll('.player-row');
  const existingIds = Array.from(existingRows).map(r => r.dataset.playerId);
  const newIds = t.roster.map(p => p.id);

  // Remove rows for deleted players
  existingRows.forEach(row => {
    if (!newIds.includes(row.dataset.playerId)) {
      row.remove();
    }
  });

  // Add or update rows
  t.roster.forEach((player, idx) => {
    let row = container.querySelector(`.player-row[data-player-id="${player.id}"]`);
    if (!row) {
      // New player — create row with slide-in animation
      row = document.createElement('div');
      row.className = 'player-row slide-in';
      row.dataset.playerId = player.id;
      row.innerHTML = _buildPlayerRowInner(team, player, idx, isDots, dotClass);
      container.appendChild(row);
    } else {
      // Existing player — update in place WITHOUT re-triggering animation
      // Update player number
      const numEl = row.querySelector('.player-num');
      if (numEl) numEl.textContent = `P${idx + 1}`;

      // Update name input (only if not currently focused)
      const nameInput = row.querySelector('.player-name-input');
      if (nameInput && nameInput !== document.activeElement) {
        nameInput.value = player.name;
      }

      // Update dots/fouls display
      const dotsContainer = row.querySelector('.dots-container');
      if (dotsContainer) {
        if (isDots) {
          const dots = dotsContainer.querySelectorAll('.dot');
          if (dots.length === 8) {
            // Update existing dots
            dots.forEach((dot, i) => {
              const shouldBeFilled = i < player.fouls;
              dot.classList.toggle('filled', shouldBeFilled);
              dot.setAttribute('onclick', `changeFoul('${team}Team', '${player.id}', ${shouldBeFilled ? -1 : 1})`);
              dot.title = `${shouldBeFilled ? 'Remove foul' : 'Add foul'} (${player.fouls}/${MAX_FOULS})`;
            });
          } else {
            // Mode changed or first render — rebuild dots
            dotsContainer.innerHTML = Array.from({ length: 8 }, (_, i) => `
              <div
                class="dot ${dotClass} ${i < player.fouls ? 'filled' : ''}"
                onclick="changeFoul('${team}Team', '${player.id}', ${i < player.fouls ? -1 : 1})"
                title="${i < player.fouls ? 'Remove foul' : 'Add foul'} (${player.fouls}/${MAX_FOULS})"
              ></div>`).join('');
          }
        } else {
          const foulNum = dotsContainer.querySelector('.foul-numeric');
          if (foulNum) {
            foulNum.textContent = `${player.fouls}/${MAX_FOULS}`;
          } else {
            dotsContainer.innerHTML = `<div class="foul-numeric">${player.fouls}/${MAX_FOULS}</div>`;
          }
        }
      }
    }
  });

  // Restore focus
  if (focusedId) {
    const el = container.querySelector(`input[data-player-id="${focusedId}"]`);
    el?.focus();
  }
}

/** Build inner HTML for a new player row */
function _buildPlayerRowInner(team, player, idx, isDots, dotClass) {
  return `
    <div class="player-num">P${idx + 1}</div>
    <input
      class="player-name-input"
      type="text"
      value="${escHtml(player.name)}"
      placeholder="Change Name"
      data-player-id="${player.id}"
      onchange="updatePlayerName('${team}Team', '${player.id}', this.value)"
    />
    <div class="dots-container">
      ${isDots
      ? Array.from({ length: 8 }, (_, i) => `
          <div
            class="dot ${dotClass} ${i < player.fouls ? 'filled' : ''}"
            onclick="changeFoul('${team}Team', '${player.id}', ${i < player.fouls ? -1 : 1})"
            title="${i < player.fouls ? 'Remove foul' : 'Add foul'} (${player.fouls}/${MAX_FOULS})"
          ></div>`).join('')
      : `<div class="foul-numeric">${player.fouls}/${MAX_FOULS}</div>`
    }
    </div>
    <div class="foul-actions">
      <button class="foul-btn penalty-trigger-btn"
        onclick="openPenaltyDialog('${team}Team','${player.id}')"
        title="Assign SPP or LPP penalty"
        style="background:var(--penalty-dim);color:var(--penalty);border:1px solid rgba(255,59,59,0.3);font-size:9px;font-weight:800;letter-spacing:0.5px;padding:0 6px;">
        P
      </button>
      <button class="foul-btn foul-dec" onclick="changeFoul('${team}Team', '${player.id}', -1)" title="Remove foul">−</button>
     <!--  <button class="foul-btn foul-inc" onclick="changeFoul('${team}Team', '${player.id}', 1)" title="Add foul">F</button> -->
    </div>
    <button class="player-del" onclick="deletePlayer('${team}Team', '${player.id}')" title="Remove player">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>
      </svg>
    </button>
  `;
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const adminEls = {};
function initAdminElements() {
  [
    'live-badge', 'toggle-dots', 'toggle-numeric',
    'home-name', 'home-score', 'home-timeouts-val', 'home-penalty',
    'away-name', 'away-score', 'away-timeouts-val', 'away-penalty',
    'match-clock-display', 'match-clock-btn',
    'home-penalty-clock-display', 'home-penalty-clock-btn', 'home-penalty-queue',
    'away-penalty-clock-display', 'away-penalty-clock-btn', 'away-penalty-queue',
    'match-duration-select',
    'home-roster-list', 'home-fouls-count',
    'away-roster-list', 'away-fouls-count',
    'home-roster-title', 'away-roster-title',
    'home-roster-penalty', 'away-roster-penalty'
  ].forEach(id => {
    adminEls[id] = document.getElementById(id);
  });
}

/* ============================================================
   BOOT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initAdminElements();
  StateManager.init();

  StateManager.subscribe((state) => {
    if (typeof renderAdmin === 'function' && document.getElementById('admin-page')) {
      renderAdmin(state);
    }
  });

  // Expose globals for inline handlers
  window.changeScore = changeScore;
  window.changeTimeout = changeTimeout;
  window.changePenalty = changePenalty;
  window.updateMatchDuration = updateMatchDuration;
  window.confirmMatchReset = confirmMatchReset;
  window.addPlayer = addPlayer;
  window.updatePlayerName = updatePlayerName;
  window.changeFoul = changeFoul;
  window.deletePlayer = deletePlayer;
  window.triggerPenalty = triggerPenalty;
  window.exportPDF = exportPDF;
  window.ClockEngine = ClockEngine;
  window.StateManager = StateManager;
  window.formatTime = formatTime;
  window._logEvent = _logEvent;
  window.MAX_PLAYERS = MAX_PLAYERS;
  window.MAX_TEAM_FOULS = MAX_TEAM_FOULS;
});
