import { useEffect, useMemo, useState } from 'react';
import './App.css';

const SEED_HISTORY = [1.32, 2.14, 1.08, 3.21, 1.54, 4.67, 1.21, 2.86, 1.03, 1.76];
// Actual visible multipliers supplied in the user's SportyBet screenshot. The screenshot
// is arranged newest-first, so the values below are stored newest-first too.
const SCREENSHOT_HISTORY = [2.77,32.83,2.52,1.00,1.05,2.07,1.03,23.28,3.79,3.33,2.74,1.66,16.30,1.03,1.60,2.56,1.39,1.41,10.77,1.43,45.49,1.00,5.92,2.82,14.80,2.97,1.12,1.34,1.11,4.79,1.47,75.78,8.20,40.62,15.24,6.66,1.15,1.20,1.08,2.16,1.02,1.55,5.54,1.77,2.09,1.20,1.32,1.26,6.27,1.00,1.67];
const STORAGE_KEY = 'skyrush-rounds-v2';

function readRounds() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (Array.isArray(stored) && stored.every(x => Number.isFinite(x.value) && x.value >= 1)) return stored;
    // Preserve previously user-entered history from the older build, but discard its fake sample rows.
    const previous = JSON.parse(localStorage.getItem('skyrush-rounds-v1') || 'null');
    if (Array.isArray(previous)) {
      const realPrevious = previous.filter(x => x && x.source !== 'sample' && Number.isFinite(x.value) && x.value >= 1);
      if (realPrevious.length) return realPrevious;
    }
  } catch {}
  return SCREENSHOT_HISTORY.map((value, i) => ({
    id: `sportybet-screenshot-${i}`, value, at: new Date(Date.now() - i * 60000).toISOString(),
    source: 'screenshot', note: 'Visible in user-provided SportyBet screenshot; order as displayed'
  }));
}
const money = n => Math.round(n).toLocaleString();
const pct = n => `${(n * 100).toFixed(1)}%`;
const median = values => {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const fmtTime = iso => {
  try { return new Date(iso).toLocaleString(); } catch { return 'Unknown'; }
};

function AnalysisPanel({ rounds, setRounds }) {
  const [url, setUrl] = useState('https://www.sportybet.com/ng/games/spribe/aviator?source=TopRibbon');
  const [liveValue, setLiveValue] = useState('');
  const [bulk, setBulk] = useState('');
  const [bulkOrder, setBulkOrder] = useState('newest');
  const [target, setTarget] = useState('1.50');
  const [estimateTarget, setEstimateTarget] = useState('1.50');
  const [stake, setStake] = useState('100');
  const [status, setStatus] = useState('');
  const [tab, setTab] = useState('stats');

  const values = useMemo(() => rounds.map(r => r.value), [rounds]);
  const stats = useMemo(() => {
    const n = values.length;
    return {
      n,
      mean: n ? values.reduce((a, b) => a + b, 0) / n : 0,
      med: median(values),
      max: n ? Math.max(...values) : 0,
      over15: n ? values.filter(v => v >= 1.5).length / n : 0,
      over2: n ? values.filter(v => v >= 2).length / n : 0,
      over3: n ? values.filter(v => v >= 3).length / n : 0,
    };
  }, [values]);

  const rolling = useMemo(() => {
    const latestFirst = values;
    const summarize = (count, targetValue = Number(estimateTarget)) => {
      const sample = latestFirst.slice(0, count);
      return { n: sample.length, hits: sample.filter(v => v >= targetValue).length,
        rate: sample.length ? sample.filter(v => v >= targetValue).length / sample.length : 0,
        median: median(sample) };
    };
    return { last20: summarize(20), last50: summarize(50), target: Number(estimateTarget) };
  }, [values, estimateTarget]);

  const estimate = useMemo(() => {
    const t = Number(estimateTarget);
    const n = values.length;
    const hits = values.filter(v => v >= t).length;
    const p = n ? hits / n : 0;
    // Wilson score interval (95%) for the historical target-hit rate.
    const z = 1.96;
    const denom = n ? 1 + (z * z) / n : 1;
    const center = n ? (p + (z * z) / (2 * n)) / denom : 0;
    const margin = n ? (z * Math.sqrt((p * (1 - p) / n) + (z * z) / (4 * n * n))) / denom : 0;
    return { target: t, n, hits, p, low: Math.max(0, center - margin), high: Math.min(1, center + margin), breakEven: t > 0 ? 1 / t : 1 };
  }, [values, estimateTarget]);

  // Recency-weighted descriptive monitor. New observations influence this readout
  // more than older ones; it describes the sample and is not a next-round forecast.
  const adaptive = useMemo(() => {
    const t = Number(estimateTarget);
    const flags = values.map(v => v >= t ? 1 : 0);
    const alpha = 0.25;
    let weighted = 0;
    let weightTotal = 0;
    flags.forEach((hit, index) => {
      const weight = Math.pow(1 - alpha, index);
      weighted += hit * weight;
      weightTotal += weight;
    });
    const ewma = weightTotal ? weighted / weightTotal : 0;
    const recent10 = flags.slice(0, 10);
    const recent20 = flags.slice(0, 20);
    const rate = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    return {
      ewma, recent10: rate(recent10), recent20: rate(recent20),
      recentN: recent10.length, overall: estimate.p,
      delta: ewma - estimate.p,
      direction: ewma > estimate.p ? 'Above full-history rate' : ewma < estimate.p ? 'Below full-history rate' : 'In line with full-history rate'
    };
  }, [values, estimateTarget, estimate.p]);

  const backtest = useMemo(() => {
    const t = Number(target), s = Number(stake);
    if (!values.length || !Number.isFinite(t) || t <= 1 || !Number.isFinite(s) || s <= 0) return null;
    const wins = values.filter(v => v >= t).length;
    const net = values.reduce((sum, v) => sum + (v >= t ? s * (t - 1) : -s), 0);
    return { wins, n: values.length, winRate: wins / values.length, net, avg: net / values.length };
  }, [values, target, stake]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rounds)); } catch {}
  }, [rounds]);

  function addResult(value, source = 'manual') {
    if (!Number.isFinite(value) || value < 1 || value > 100000) {
      setStatus('Enter a valid multiplier of 1.00 or higher.');
      return false;
    }
    setRounds(prev => [{
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      value: Number(value.toFixed(2)), at: new Date().toISOString(), source,
      note: source === 'manual' ? 'Entered by user' : source === 'import' ? 'Imported by user' : 'Screenshot history'
    }, ...prev.filter(r => r.source !== 'sample')].slice(0, 5000));
    setStatus(`Recorded ${Number(value).toFixed(2)}× as ${source === 'manual' ? 'a manually observed result' : 'an imported result'}.`);
    return true;
  }

  function addLive() {
    const value = Number(liveValue);
    if (addResult(value, 'manual')) setLiveValue('');
  }

  function importResults() {
    const tokens = bulk.split(/[\s,;]+/).map(x => x.trim().replace(/[×xX]$/, '')).filter(Boolean);
    if (!tokens.length) { setStatus('Paste multipliers separated by commas, spaces, or new lines.'); return; }
    const parsed = tokens.map(Number);
    if (parsed.some(v => !Number.isFinite(v) || v < 1 || v > 100000)) {
      setStatus('Import stopped: every item must be a number of 1.00 or higher. Nothing was imported.');
      return;
    }
    const now = Date.now();
    // The Analysis Lab stores newest first. If the pasted list is newest-first,
    // reverse it before assigning timestamps; oldest-first imports stay as-is.
    const chronological = bulkOrder === 'newest' ? [...parsed].reverse() : parsed;
    const newRows = chronological.map((value, i) => ({
      id: `import-${now}-${i}-${Math.random().toString(36).slice(2, 6)}`,
      value: Number(value.toFixed(2)), at: new Date(now - (chronological.length - i) * 1000).toISOString(),
      source: 'import', note: 'Imported by user'
    })).reverse();
    setRounds(prev => [...newRows, ...prev.filter(r => r.source !== 'sample')].slice(0, 5000));
    setBulk('');
    setStatus(`Imported ${parsed.length} results. They are historical observations, not predictions.`);
  }

  function exportCsv() {
    const lines = ['timestamp,multiplier,source,note', ...rounds.map(r =>
      [r.at, r.value, r.source, `"${String(r.note || '').replaceAll('"', '""')}"`].join(',')
    )];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'skyrush-round-history.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus('CSV export created.');
  }

  function clearImported() {
    if (!window.confirm('Remove all recorded rounds and restore the illustrative sample history?')) return;
    setRounds(SEED_HISTORY.map((value, i) => ({
      id: `sample-${Date.now()}-${i}`, value, at: new Date(Date.now() - (SEED_HISTORY.length - i) * 60000).toISOString(),
      source: 'sample', note: 'Illustrative sample data'
    })));
    setStatus('History reset to illustrative sample data.');
  }

  function openReference() {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !['sportybet.com', 'www.sportybet.com'].includes(parsed.hostname)) {
        setStatus('For safety, this reference field only opens HTTPS SportyBet Nigeria URLs.');
        return;
      }
      window.open(parsed.href, '_blank', 'noopener,noreferrer');
      setStatus('Opened SportyBet in a new tab. SkyRush does not read or scrape that page.');
    } catch {
      setStatus('Enter a valid HTTPS SportyBet URL.');
    }
  }

  const chart = values.slice(0, 30).reverse();
  return (
    <section className="analysis-shell">
      <div className="analysis-heading">
        <div>
          <p className="eyebrow">SKYRUSH LAB · ANALYSIS ONLY</p>
          <h2>Round analysis</h2>
          <p className="muted">Starts with 51 multipliers read from your screenshot. Every result you enter updates the full-history, rolling-window and recency-weighted summaries immediately. This does not forecast the next crash point.</p>
        </div>
        <span className="mode-pill"><i /> LOCAL DATA</span>
      </div>

      <div className="source-card">
        <div className="source-copy">
          <span className="micro-label">GAME REFERENCE LINK</span>
          <strong>SportyBet Nigeria · Aviator</strong>
          <p>The URL is a shortcut for your own viewing. It does not grant SkyRush access to private game data.</p>
        </div>
        <div className="url-row">
          <input aria-label="SportyBet reference URL" value={url} onChange={e => setUrl(e.target.value)} />
          <button className="secondary-button" onClick={openReference}>Open game ↗</button>
        </div>
      </div>

      <div className="analysis-tabs" role="tablist">
        <button className={tab === 'stats' ? 'selected' : ''} onClick={() => setTab('stats')}>Historical stats</button>
        <button className={tab === 'live' ? 'selected' : ''} onClick={() => setTab('live')}>Live result log</button>
        <button className={tab === 'test' ? 'selected' : ''} onClick={() => setTab('test')}>Strategy backtest</button>
      </div>

      {tab === 'stats' && <>
        <div className="stat-grid">
          <Stat label="RECORDED ROUNDS" value={stats.n.toLocaleString()} />
          <Stat label="MEDIAN MULTIPLIER" value={`${stats.med.toFixed(2)}×`} />
          <Stat label="HIGHEST RECORDED" value={`${stats.max.toFixed(2)}×`} />
          <Stat label="AVERAGE MULTIPLIER" value={`${stats.mean.toFixed(2)}×`} />
        </div>
        <div className="content-card estimate-card">
          <div className="card-title-row"><div><h3>Pre-round probability estimate</h3><p>Estimate the historical chance of reaching a chosen cash-out target using only the rounds you've recorded.</p></div><span className="tag">HISTORICAL MODEL</span></div>
          <div className="estimate-controls">
            <label>Target multiplier
              <select value={estimateTarget} onChange={e => setEstimateTarget(e.target.value)}>
                <option value="1.20">1.20×</option><option value="1.50">1.50×</option><option value="1.80">1.80×</option><option value="2.00">2.00×</option><option value="3.00">3.00×</option><option value="5.00">5.00×</option>
              </select>
            </label>
            <div className="estimate-main"><span>Observed hit rate</span><strong>{pct(estimate.p)}</strong></div>
            <div className="estimate-main"><span>Approx. 95% interval</span><strong>{pct(estimate.low)}–{pct(estimate.high)}</strong></div>
          </div>
          <div className="estimate-bar"><div style={{width: `${estimate.p * 100}%`}} /></div>
          <div className="estimate-details"><span>{estimate.hits} of {estimate.n} recorded rounds reached {estimate.target.toFixed(2)}×</span><span>Break-even hit rate before costs: {pct(estimate.breakEven)}</span></div>
          <div className="no-signal"><strong>NO VERIFIED BET SIGNAL</strong><p>This is a summary of past results, not a forecast for the next round. Even if the observed rate is above break-even, random variation and changing or independent outcomes can erase that apparent edge. SkyRush cannot identify a reliable “bet now” moment from these results.</p></div>
          <p className="footnote">The interval describes uncertainty in the historical hit rate under a simple binomial assumption. It does not include data-entry errors, selection bias, changes in game implementation, or guarantee that future rounds follow the same distribution. The starting sample is the 51 outcomes visible in your screenshot.</p>
        </div>
        <div className="content-card">
          <div className="card-title-row"><div><h3>Adaptive rolling readout</h3><p>These windows refresh automatically every time you record or import a result.</p></div><span className="tag">AUTO-UPDATED</span></div>
          <div className="backtest-results">
            <div><span>Latest 20 · reached {rolling.target.toFixed(2)}×</span><strong>{pct(rolling.last20.rate)}</strong><small>{rolling.last20.hits}/{rolling.last20.n} rounds · median {rolling.last20.median.toFixed(2)}×</small></div>
            <div><span>Latest 50 · reached {rolling.target.toFixed(2)}×</span><strong>{pct(rolling.last50.rate)}</strong><small>{rolling.last50.hits}/{rolling.last50.n} rounds · median {rolling.last50.median.toFixed(2)}×</small></div>
          </div>
          <p className="footnote">Rolling windows can reveal changes in the recent sample, but they do not establish that the next crash point is more likely to reach the target. Results may be independent from round to round.</p>
        </div>
        <div className="content-card">
          <div className="card-title-row"><div><h3>Adaptive recent-outcome monitor</h3><p>Recent results receive more weight, so this panel responds quickly when you add a new round.</p></div><span className="tag">RECENCY-WEIGHTED</span></div>
          <div className="backtest-results">
            <div><span>Weighted recent hit rate · {rolling.target.toFixed(2)}×</span><strong>{pct(adaptive.ewma)}</strong><small>Recent outcomes count more heavily</small></div>
            <div><span>Last 10 rounds</span><strong>{pct(adaptive.recent10)}</strong><small>{adaptive.recent10 === 0 ? '0' : Math.round(adaptive.recent10 * adaptive.recentN)}/{adaptive.recentN} reached target</small></div>
            <div><span>Last 20 rounds</span><strong>{pct(adaptive.recent20)}</strong><small>{Math.min(20, values.length)} observations</small></div>
            <div><span>Compared with all history</span><strong className={adaptive.delta >= 0 ? 'text-green' : 'text-red'}>{adaptive.delta >= 0 ? '+' : ''}{(adaptive.delta * 100).toFixed(1)} pp</strong><small>{adaptive.direction}</small></div>
          </div>
          <p className="footnote">This is an adaptive description of the results you feed SkyRush. It is not evidence that the next round is more or less likely to reach the target.</p>
        </div>
        <div className="content-card">
          <div className="card-title-row"><div><h3>Observed threshold frequency</h3><p>Share of recorded rounds at or above each threshold.</p></div><span className="tag">DESCRIPTIVE ONLY</span></div>
          <div className="frequency-list">
            <Frequency label="≥ 1.50×" value={stats.over15} />
            <Frequency label="≥ 2.00×" value={stats.over2} />
            <Frequency label="≥ 3.00×" value={stats.over3} />
          </div>
          <p className="footnote">Initial history is the 51 visible results from your screenshot. Newly entered results are added to the top of the log and included in the statistics.</p>
        </div>
        <div className="content-card">
          <div className="card-title-row"><div><h3>Latest recorded multipliers</h3><p>Most recent 30 observations, newest on the right.</p></div><span className="tag">{chart.length} POINTS</span></div>
          <div className="bar-chart" aria-label="Historical multiplier chart">
            {chart.map((v, i) => <div key={`${i}-${v}`} className="bar-wrap" title={`${v.toFixed(2)}×`}>
              <div className={`bar ${v >= 2 ? 'bar-high' : ''}`} style={{height: `${Math.max(3, Math.min(100, (v / Math.max(3, ...chart)) * 100))}%`}} />
            </div>)}
          </div>
          <p className="footnote">Chart scale is relative to the values currently shown. This is not a live forecast.</p>
        </div>
      </>}

      {tab === 'live' && <>
        <div className="content-card">
          <div className="card-title-row"><div><h3>Quick live result entry</h3><p>Enter each final multiplier as soon as the round ends. Press Enter to save; all analysis panels refresh immediately.</p></div><span className="tag">USER-RECORDED</span></div>
          <div className="input-action-row">
            <div className="field-with-suffix"><input type="number" min="1" step="0.01" placeholder="e.g. 1.74" value={liveValue} onChange={e => setLiveValue(e.target.value)} onKeyDown={e => e.key === 'Enter' && addLive()} /><span>×</span></div>
            <button className="primary-button compact" onClick={addLive}>Save round ↵</button>
          </div>
        </div>
        <div className="content-card">
          <div className="card-title-row"><div><h3>Fast result feed</h3><p>Paste a whole batch from the SportyBet results display. Supports values such as 2.77x, 32.83x, 1.00x or plain numbers.</p></div><span className="tag">BATCH INPUT</span></div>
          <label className="import-order-label">Order of pasted results
            <select value={bulkOrder} onChange={e => setBulkOrder(e.target.value)}>
              <option value="newest">Newest first (like the game history strip)</option>
              <option value="oldest">Oldest first</option>
            </select>
          </label>
          <textarea rows="4" value={bulk} onChange={e => setBulk(e.target.value)} placeholder={'2.77x 32.83x 2.52x 1.00x 1.05x'} />
          <div className="button-row"><button className="secondary-button" onClick={importResults}>Process results instantly</button><button className="secondary-button" onClick={exportCsv}>Export CSV ↓</button><button className="text-button" onClick={clearImported}>Reset history</button></div>
        </div>
        <div className="content-card">
          <div className="card-title-row"><div><h3>Round log</h3><p>Stored in this browser on this device.</p></div><span className="tag">{rounds.length} TOTAL</span></div>
          <div className="round-table">
            <div className="round-table-head"><span>Multiplier</span><span>Source</span><span>Recorded at</span></div>
            {rounds.slice(0, 20).map(r => <div className="round-row" key={r.id}>
              <strong className={r.value >= 2 ? 'text-green' : ''}>{r.value.toFixed(2)}×</strong>
              <span className={`source-label ${r.source}`}>{r.source}</span>
              <time>{fmtTime(r.at)}</time>
            </div>)}
          </div>
          <p className="footnote">Up to 5,000 rounds are kept in browser storage. Clearing browser data may remove them; export CSV for a backup.</p>
        </div>
      </>}

      {tab === 'test' && <>
        <div className="content-card">
          <div className="card-title-row"><div><h3>Historical strategy backtest</h3><p>Apply a fixed cash-out target to recorded multipliers. No real bets are placed.</p></div><span className="tag">HISTORICAL ONLY</span></div>
          <div className="test-controls">
            <label>Cash-out target
              <select value={target} onChange={e => setTarget(e.target.value)}>
                <option value="1.20">1.20×</option><option value="1.50">1.50×</option><option value="1.80">1.80×</option><option value="2.00">2.00×</option><option value="3.00">3.00×</option><option value="5.00">5.00×</option>
              </select>
            </label>
            <label>Hypothetical stake (points)
              <input type="number" min="1" value={stake} onChange={e => setStake(e.target.value)} />
            </label>
          </div>
          {backtest && <div className="backtest-results">
            <div><span>Historical target-hit rate</span><strong>{pct(backtest.winRate)}</strong></div>
            <div><span>Rounds tested</span><strong>{backtest.n}</strong></div>
            <div><span>Hypothetical net points</span><strong className={backtest.net >= 0 ? 'text-green' : 'text-red'}>{backtest.net >= 0 ? '+' : ''}{money(backtest.net)}</strong></div>
            <div><span>Average per recorded round</span><strong className={backtest.avg >= 0 ? 'text-green' : 'text-red'}>{backtest.avg >= 0 ? '+' : ''}{backtest.avg.toFixed(2)}</strong></div>
          </div>}
          <p className="footnote">Simplified calculation: if a recorded multiplier reaches the target, net = stake × (target − 1); otherwise net = −stake. It ignores provider-specific rules, timing, fees, and data-quality problems. It is not a forecast or proof of future profitability.</p>
        </div>
        <div className="warning-card"><strong>Prediction status: NOT AVAILABLE</strong><p>SkyRush does not estimate the next crash point. A strategy that did well on past results can fail on future rounds, especially if the sample is small or biased.</p></div>
      </>}

      {status && <div className="status-message" role="status">{status}</div>}
      <div className="analysis-disclaimer"><strong>Data boundary:</strong> SkyRush does not log in to SportyBet, inspect private endpoints, bypass access controls, or scrape the game frame. Historical values are user-entered/imported unless explicitly labelled sample.</div>
    </section>
  );
}

function Stat({ label, value }) {
  return <div className="stat-card"><span>{label}</span><strong>{value}</strong></div>;
}
function Frequency({ label, value }) {
  return <div className="frequency-row"><span>{label}</span><div className="frequency-track"><div style={{width: `${Math.max(0, Math.min(100, value * 100))}%`}} /></div><strong>{pct(value)}</strong></div>;
}

function GamePanel() {
  const [balance, setBalance] = useState(1000);
  const [bet, setBet] = useState(50);
  const [phase, setPhase] = useState('waiting');
  const [multiplier, setMultiplier] = useState(1);
  const [history, setHistory] = useState(SEED_HISTORY.slice(0, 5));
  const [round, setRound] = useState(1);
  const [countdown, setCountdown] = useState(5);
  const [activeBet, setActiveBet] = useState(false);
  const [roundBet, setRoundBet] = useState(0);
  const [cashedOut, setCashedOut] = useState(false);
  const [cashoutAt, setCashoutAt] = useState(0);
  const [message, setMessage] = useState('Place a demo bet to join the next flight.');
  const [lastWin, setLastWin] = useState(0);
  const [flightResults, setFlightResults] = useState([]);
  const [roundLog, setRoundLog] = useState([]);
  const [autoTarget, setAutoTarget] = useState('1.50');

  useEffect(() => {
    if (phase !== 'waiting') return;
    setCountdown(5);
    let count = 5;
    const timer = setInterval(() => {
      count -= 1; setCountdown(count);
      if (count <= 0) {
        clearInterval(timer);
        startRound();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [phase, round]);

  useEffect(() => {
    if (phase !== 'flying' || !activeBet || cashedOut) return;
    if (multiplier >= Number(autoTarget)) {
      doCashOut();
    }
  }, [multiplier, phase, activeBet, cashedOut, autoTarget]);

  function startRound() {
    const crash = Math.random() < 0.2 ? 1.1 + Math.random() * 0.8 : 1.7 + Math.random() * 5.3;
    setPhase('flying'); setMultiplier(1); setCashedOut(false); setCashoutAt(0); setLastWin(0);
    setMessage('The plane is flying. Cash out before the flight ends.');
    const start = Date.now();
    const timer = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      const next = Math.exp(elapsed * (0.17 + Math.min(round * 0.012, 0.2)));
      if (next >= crash) {
        clearInterval(timer);
        const result = Number(crash.toFixed(2));
        setMultiplier(result); setHistory(h => [result, ...h].slice(0, 8));
        setFlightResults(prev => [{ value: result, at: new Date().toISOString() }, ...prev].slice(0, 500));
        setPhase('crashed'); setActiveBet(false); setRoundBet(0);
        setRoundLog(prev => [{ value: result, at: new Date().toISOString(), round }, ...prev].slice(0, 500));
        setMessage(cashedOut ? 'Nice timing. Your virtual points are secured.' : 'Flight ended. Ready for another round?');
        setRound(r => r + 1);
      } else setMultiplier(next);
    }, 50);
    // A small module-local reference allows the current game timer to be stopped on reset.
    window.__skyRushTimer && clearInterval(window.__skyRushTimer);
    window.__skyRushTimer = timer;
  }

  function doCashOut() {
    if (phase !== 'flying' || !activeBet || cashedOut) return;
    const winnings = Math.floor(roundBet * multiplier);
    setBalance(b => b + winnings); setLastWin(winnings); setCashedOut(true);
    setCashoutAt(multiplier); setActiveBet(false);
    setMessage(`Cashed out at ${multiplier.toFixed(2)}×. You received ${winnings} demo points.`);
  }
  function placeBet() {
    if (phase !== 'waiting' || activeBet) return;
    if (!Number.isFinite(bet) || bet < 10 || bet > balance) { setMessage('Choose a bet from 10 points up to your balance.'); return; }
    setBalance(b => b - bet); setRoundBet(bet); setActiveBet(true); setMessage(`Your ${bet} point demo bet is in.`);
  }

  const planeX = phase === 'waiting' ? 8 : Math.min(76, 8 + Math.log(multiplier) * 19);
  const planeY = phase === 'waiting' ? 12 : Math.min(72, 12 + Math.log(multiplier) * 16);
  const curveY = phase === 'waiting' ? 370 : 370 - Math.min(310, Math.log(multiplier) * 115);

  return <section className="game-layout">
    <div className="game-panel">
      <div className="panel-head"><span><i className={`status-dot ${phase}`} />{phase === 'flying' ? 'IN FLIGHT' : phase === 'waiting' ? 'NEXT FLIGHT' : 'FLIGHT ENDED'}</span><small>LOCAL SIMULATION</small></div>
      <div className={`flight-stage ${phase}`}>
        <div className="stars stars-one">✦　·　✧　　·　✦</div><div className="stars stars-two">·　✧　　✦　　·</div><div className="stage-glow" />
        <svg className="flight-curve" viewBox="0 0 800 390" preserveAspectRatio="none"><defs><linearGradient id="curveGradient" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stopColor="#36d9a0" stopOpacity=".05" /><stop offset="100%" stopColor="#36d9a0" stopOpacity=".9" /></linearGradient></defs><path d={`M 0 370 L 800 ${curveY}`} fill="none" stroke="url(#curveGradient)" strokeWidth="4" strokeLinecap="round" /></svg>
        <div className="plane" style={{left:`${planeX}%`,bottom:`${planeY}%`}}>✈</div>
        <div className="multiplier-wrap">
          {phase === 'waiting' ? <><span className="wait-label">NEXT FLIGHT IN</span><div className="big-multiplier waiting-number">00:0{Math.max(0,countdown)}</div><p className="stage-caption">Get ready for take-off</p></> :
          phase === 'crashed' ? <><span className="wait-label">FLIGHT ENDED AT</span><div className="big-multiplier crashed-number">{multiplier.toFixed(2)}<small>×</small></div><p className="stage-caption">{cashedOut ? `You left at ${cashoutAt.toFixed(2)}×` : 'Ready for the next flight?'}</p></> :
          <><span className="wait-label">CURRENT MULTIPLIER</span><div className="big-multiplier">{multiplier.toFixed(2)}<small>×</small></div><p className="stage-caption">{cashedOut ? `Cashed out at ${cashoutAt.toFixed(2)}×` : 'Multiplier is climbing...'}</p></>}
        </div>
        <div className="stage-footer"><span>SKYRUSH FLIGHT ENGINE</span><span>● VIRTUAL PLAY</span></div>
      </div>
      <div className="history-strip"><span className="history-title">LAST FLIGHTS</span><div className="history-list">{history.map((v,i)=><span key={`${v}-${i}`} className={`history-chip ${v>=2?'good':'low'}`}>{v.toFixed(2)}×</span>)}</div></div>
      <div className="disclaimer">ⓘ Demo simulation only. Results are random and do not predict future rounds.</div>
    </div>
    <aside className="control-panel">
      <div className="control-heading"><div><p className="eyebrow">YOUR CONTROLS</p><h2>Flight deck</h2></div><span className="control-icon">⌁</span></div>
      <div className="bet-label-row"><label htmlFor="bet-amount">DEMO BET AMOUNT</label><span>MIN. 10 PTS</span></div>
      <div className="bet-input-wrap"><span className="coin-symbol">◈</span><input id="bet-amount" type="number" min="10" max={balance} step="10" value={bet} onChange={e=>setBet(Number(e.target.value))} disabled={phase!=='waiting'||activeBet}/><span className="pts">PTS</span></div>
      <div className="quick-bets">{[50,100,250,500].map(n=><button key={n} disabled={phase!=='waiting'||activeBet||n>balance} onClick={()=>setBet(n)}>{n}</button>)}</div>
      <div className="auto-target"><label htmlFor="auto-target">DEMO AUTO-CASH-OUT</label><select id="auto-target" value={autoTarget} onChange={e=>setAutoTarget(e.target.value)}><option value="1.20">1.20×</option><option value="1.50">1.50×</option><option value="1.80">1.80×</option><option value="2.00">2.00×</option><option value="3.00">3.00×</option></select><small>Applies only to this local demo.</small></div>
      <div className="divider-line" /><div className="potential-row"><span>Potential return</span><strong>◈ {money(Math.floor(bet*(phase==='flying'?multiplier:2)))} <small>PTS</small></strong></div>
      {phase==='waiting'?<button className="primary-button" disabled={activeBet||balance<10} onClick={placeBet}>{activeBet?'BET PLACED ✓':'PLACE DEMO BET'} <span>↗</span></button>:phase==='flying'?<button className={`primary-button cashout-button ${cashedOut?'done':''}`} disabled={!activeBet||cashedOut} onClick={doCashOut}>{cashedOut?'CASHED OUT ✓':'CASH OUT'} <span>{cashedOut?`+${lastWin}`:`◈ ${money(Math.floor(roundBet*multiplier))}`}</span></button>:<button className="primary-button" onClick={()=>{setPhase('waiting');setMessage('Place a demo bet to join the next flight.')}}>NEXT ROUND <span>↻</span></button>}
      <p className="control-message">{message}</p><div className="round-summary"><div className="summary-icon">✦</div><div><strong>{cashedOut?'Great flight!':phase==='crashed'?'Flight complete':'Play it smart'}</strong><p>{cashedOut?`You secured ${lastWin} virtual points.`:'Practice with virtual points. No money involved.'}</p></div></div><div className="fair-play">◇ &nbsp; No deposits. No payouts. Just a demo.</div>
    </aside>
  </section>;
}

export default function App() {
  const [page, setPage] = useState('game');
  const [rounds, setRounds] = useState(readRounds);
  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="#" onClick={e=>{e.preventDefault();setPage('game')}}><span className="brand-mark">✈</span><span>SKY<span className="green">RUSH</span><small>ARCADE</small></span></a>
      <nav className="main-nav"><button className={page==='game'?'nav-active':''} onClick={()=>setPage('game')}>Demo game</button><button className={page==='analysis'?'nav-active':''} onClick={()=>setPage('analysis')}>Analysis lab</button></nav>
      <div className="demo-tag"><i /> DEMO MODE</div>
    </header>
    {page==='game' ? <>
      <section className="intro"><div><p className="eyebrow">ARCADE GAME · PLAY FOR FUN</p><h1>Catch the <span>flight.</span></h1><p className="subheading">Watch the multiplier rise. Cash out before the plane disappears.</p></div><div className="round-pill">LOCAL <strong>DEMO</strong></div></section>
      <GamePanel />
    </> : <AnalysisPanel rounds={rounds} setRounds={setRounds} />}
    <footer className="footer"><span>SKYRUSH ARCADE</span><span>VIRTUAL POINTS · HISTORICAL ANALYSIS ONLY</span></footer>
  </main>;
}
