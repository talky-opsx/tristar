/**
 * TriFit Masters - コアロジック
 * hrTSS計算、膝ストレス、GO/NO-GO判定
 */

// 年齢グループ別補正係数
const AG_CONFIG = {
  '40-44': { recoveryMult: 1.00, weeklyTSSCap: 520, runKmCap: 45, kneeMult: 1.00 },
  '45-49': { recoveryMult: 1.15, weeklyTSSCap: 460, runKmCap: 38, kneeMult: 1.15 },
  '50-54': { recoveryMult: 1.35, weeklyTSSCap: 400, runKmCap: 32, kneeMult: 1.35 },
  '55-59': { recoveryMult: 1.55, weeklyTSSCap: 340, runKmCap: 26, kneeMult: 1.60 },
  '60+':   { recoveryMult: 1.75, weeklyTSSCap: 280, runKmCap: 20, kneeMult: 1.85 },
};

// デフォルト設定
const DEFAULTS = {
  lthr: 163,
  swimLthr: 153,
  ageGroup: '45-49',
};

// 週間TSS種目配分（70.3向け）
const SPORT_RATIO = { swim: 0.13, bike: 0.50, run: 0.37 };

/**
 * hrTSS計算
 * @param {number} durationSec - 活動時間（秒）
 * @param {number} avgHR - 平均心拍数
 * @param {number} lthr - 乳酸閾値心拍数
 * @returns {number} hrTSS値
 */
function calcHrTSS(durationSec, avgHR, lthr) {
  const durationH = durationSec / 3600;
  return Math.round(durationH * Math.pow(avgHR / lthr, 2) * 100);
}

/**
 * 膝ストレス指数計算
 */
function calcKneeStress(weekRunKm, cadenceSpm, elevGain, gct, vo, kneeMult, runKmCap) {
  const kmFactor   = Math.min(weekRunKm / runKmCap, 1.5) * 35;
  const cadFactor  = cadenceSpm < 170 ? (1 - cadenceSpm / 170) * 20 : 0;
  const elevFactor = Math.min(elevGain / 200, 1.5) * 12;
  const gctFactor  = gct ? Math.max(0, (gct / 280 - 1) * 15) : 0;
  const voFactor   = vo  ? Math.max(0, (vo / 70 - 1) * 10)   : 0;
  const raw = kmFactor + cadFactor + elevFactor + gctFactor + voFactor;
  return Math.min(Math.round(raw * kneeMult), 100);
}

/**
 * GO/NO-GO判定
 * @returns {{ label: 'GREEN'|'YELLOW'|'RED', recH: number }}
 */
function getVerdict(totalTSS, kneeScore, recoveryMult, weeklyTSSCap) {
  const tssRatio = totalTSS / weeklyTSSCap;
  const recH = Math.round(18 * recoveryMult);
  if (kneeScore > 75 || tssRatio > 0.95) return { label: 'RED',    recH };
  if (kneeScore > 55 || tssRatio > 0.78) return { label: 'YELLOW', recH };
  return                                         { label: 'GREEN',  recH };
}

/**
 * localStorageベースの簡易データストア
 */
const Store = {
  _key(name) { return `trifit_${name}`; },

  getSettings() {
    const raw = localStorage.getItem(this._key('settings'));
    return raw ? JSON.parse(raw) : { ...DEFAULTS };
  },

  saveSettings(s) {
    localStorage.setItem(this._key('settings'), JSON.stringify(s));
  },

  // 週間ログ取得（今週月曜〜日曜）
  getWeekLogs() {
    const raw = localStorage.getItem(this._key('week_logs'));
    return raw ? JSON.parse(raw) : [];
  },

  addLog(log) {
    const logs = this.getWeekLogs();
    logs.push({ ...log, ts: Date.now() });
    localStorage.setItem(this._key('week_logs'), JSON.stringify(logs));
  },

  // 今日の手動入力を取得/保存
  getTodayInput() {
    const key = this._key('today_' + new Date().toISOString().slice(0, 10));
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  },

  saveTodayInput(data) {
    const key = this._key('today_' + new Date().toISOString().slice(0, 10));
    localStorage.setItem(key, JSON.stringify(data));
  },
};

/**
 * 週間サマリーを計算
 */
function calcWeekSummary() {
  const settings = Store.getSettings();
  const ag = AG_CONFIG[settings.ageGroup] || AG_CONFIG['45-49'];
  const logs = Store.getWeekLogs();

  let totalTSS = 0;
  let swimTSS = 0, bikeTSS = 0, runTSS = 0;
  let weekRunKm = 0;
  let lastCadence = 170, lastElev = 0, lastGct = null, lastVo = null;

  for (const log of logs) {
    const lthr = log.sport === 'swim' ? (settings.swimLthr || 153) : settings.lthr;
    const tss = calcHrTSS(log.durationSec, log.avgHR, lthr);
    totalTSS += tss;

    if (log.sport === 'swim') swimTSS += tss;
    else if (log.sport === 'bike') bikeTSS += tss;
    else if (log.sport === 'run') {
      runTSS += tss;
      weekRunKm += (log.distanceM || 0) / 1000;
      if (log.cadence) lastCadence = log.cadence;
      if (log.elevGain) lastElev += log.elevGain;
      if (log.gct) lastGct = log.gct;
      if (log.vo) lastVo = log.vo;
    }
  }

  const kneeScore = calcKneeStress(weekRunKm, lastCadence, lastElev, lastGct, lastVo, ag.kneeMult, ag.runKmCap);
  const verdict = getVerdict(totalTSS, kneeScore, ag.recoveryMult, ag.weeklyTSSCap);

  return {
    totalTSS,
    swimTSS,
    bikeTSS,
    runTSS,
    weekRunKm: Math.round(weekRunKm * 10) / 10,
    kneeScore,
    verdict,
    tssRatio: Math.round((totalTSS / ag.weeklyTSSCap) * 100),
    weeklyTSSCap: ag.weeklyTSSCap,
  };
}

export {
  AG_CONFIG, DEFAULTS, SPORT_RATIO,
  calcHrTSS, calcKneeStress, getVerdict,
  Store, calcWeekSummary,
};
