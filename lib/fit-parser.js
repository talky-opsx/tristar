/**
 * FITファイルパーサー
 * Garmin FITバイナリをデコードしてセッション情報を抽出
 * 参考: FIT SDK Profile.xlsx / fit-file-parser npm
 */

// FITプロトコル定数
const FIT_HEADER_SIZE = 14;
const MESG_NUM_SESSION = 18;
const MESG_NUM_RECORD = 20;
const MESG_NUM_FILE_ID = 0;

// FITベースタイプ定義
const BASE_TYPES = {
  0x00: { size: 1, name: 'enum' },
  0x01: { size: 1, name: 'sint8' },
  0x02: { size: 1, name: 'uint8' },
  0x83: { size: 2, name: 'sint16' },
  0x84: { size: 2, name: 'uint16' },
  0x85: { size: 4, name: 'sint32' },
  0x86: { size: 4, name: 'uint32' },
  0x07: { size: 1, name: 'string' },
  0x88: { size: 4, name: 'float32' },
  0x89: { size: 8, name: 'float64' },
  0x0A: { size: 1, name: 'uint8z' },
  0x8B: { size: 2, name: 'uint16z' },
  0x8C: { size: 4, name: 'uint32z' },
  0x0D: { size: 1, name: 'byte' },
  0x8E: { size: 8, name: 'sint64' },
  0x8F: { size: 8, name: 'uint64' },
  0x90: { size: 8, name: 'uint64z' },
};

// Garmin sport enum
const SPORT_MAP = {
  0: 'generic', 1: 'run', 2: 'bike', 5: 'swim',
  11: 'walk', 15: 'multi_sport', 17: 'cardio', 24: 'strength',
};

// セッションフィールド定義番号
const SESSION_FIELDS = {
  0: 'event', 1: 'event_type', 2: 'start_time', 5: 'sport',
  7: 'total_elapsed_time', 8: 'total_timer_time', 9: 'total_distance',
  11: 'total_cycles', 14: 'avg_speed', 15: 'max_speed',
  16: 'avg_heart_rate', 17: 'max_heart_rate', 18: 'avg_cadence',
  22: 'total_ascent', 23: 'total_descent',
  49: 'avg_power', 168: 'enhanced_avg_speed',
};

// レコードフィールド定義番号
const RECORD_FIELDS = {
  0: 'heart_rate', 1: 'cadence', 2: 'distance',
  4: 'speed', 6: 'enhanced_speed', 78: 'enhanced_altitude',
  39: 'stance_time', 40: 'vertical_oscillation',
  83: 'vertical_ratio', 84: 'stance_time_balance',
  7: 'power',
};

function readValue(view, offset, baseType, size) {
  const bt = baseType & 0x1F;
  const isEndian = (baseType & 0x80) !== 0;
  const littleEndian = true;
  try {
    switch (bt) {
      case 0x00: // enum
      case 0x02: // uint8
      case 0x0A: // uint8z
      case 0x0D: // byte
        return view.getUint8(offset);
      case 0x01: // sint8
        return view.getInt8(offset);
      case 0x03: // sint16
        return view.getInt16(offset, littleEndian);
      case 0x04: // uint16
      case 0x0B: // uint16z
        return view.getUint16(offset, littleEndian);
      case 0x05: // sint32
        return view.getInt32(offset, littleEndian);
      case 0x06: // uint32
      case 0x0C: // uint32z
        return view.getUint32(offset, littleEndian);
      case 0x08: // float32
        return view.getFloat32(offset, littleEndian);
      case 0x09: // float64
        return view.getFloat64(offset, littleEndian);
      case 0x07: // string
        let str = '';
        for (let i = 0; i < size; i++) {
          const c = view.getUint8(offset + i);
          if (c === 0) break;
          str += String.fromCharCode(c);
        }
        return str;
      default:
        return view.getUint8(offset);
    }
  } catch {
    return null;
  }
}

function getBaseTypeSize(baseType) {
  const bt = baseType & 0x1F;
  const info = BASE_TYPES[bt] || BASE_TYPES[baseType];
  return info ? info.size : 1;
}

/**
 * FITバイナリをパースしてセッション情報とレコードを返す
 */
function parseFIT(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);

  // ヘッダー検証
  const headerSize = view.getUint8(0);
  const dataSize = view.getUint32(4, true);
  const signature = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (signature !== '.FIT') {
    throw new Error('無効なFITファイルです');
  }

  let offset = headerSize;
  const endOffset = headerSize + dataSize;
  const localDefs = {};
  const sessions = [];
  const records = [];

  while (offset < endOffset) {
    const recordHeader = bytes[offset];
    offset++;

    const isDefinition = (recordHeader & 0x40) !== 0;
    const localType = recordHeader & 0x0F;
    const isCompressedTimestamp = (recordHeader & 0x80) !== 0;

    if (isCompressedTimestamp) {
      // 圧縮タイムスタンプ - データメッセージとして処理
      const ctLocalType = (recordHeader >> 5) & 0x03;
      const def = localDefs[ctLocalType];
      if (!def) { offset += 1; continue; }
      // フィールドをスキップ
      let msgSize = 0;
      for (const f of def.fields) msgSize += f.size;
      offset += msgSize;
      continue;
    }

    if (isDefinition) {
      // 定義メッセージ
      offset++; // reserved
      const arch = bytes[offset]; offset++; // architecture (0=little, 1=big)
      const globalMesgNum = view.getUint16(offset, true); offset += 2;
      const numFields = bytes[offset]; offset++;

      const fields = [];
      for (let i = 0; i < numFields; i++) {
        const fieldDefNum = bytes[offset]; offset++;
        const fieldSize = bytes[offset]; offset++;
        const baseType = bytes[offset]; offset++;
        fields.push({ fieldDefNum, size: fieldSize, baseType });
      }

      // Developer fields (もしあれば)
      const hasDeveloperData = (recordHeader & 0x20) !== 0;
      let devFields = [];
      if (hasDeveloperData) {
        const numDevFields = bytes[offset]; offset++;
        for (let i = 0; i < numDevFields; i++) {
          const fNum = bytes[offset]; offset++;
          const fSize = bytes[offset]; offset++;
          const devIdx = bytes[offset]; offset++;
          devFields.push({ fNum, size: fSize, devIdx });
        }
      }

      localDefs[localType] = { globalMesgNum, fields, devFields };
    } else {
      // データメッセージ
      const def = localDefs[localType];
      if (!def) { continue; }

      const msg = {};
      for (const f of def.fields) {
        const val = readValue(view, offset, f.baseType, f.size);
        offset += f.size;

        // 無効値チェック
        if (val === null || val === 0xFF || val === 0xFFFF || val === 0xFFFFFFFF || val === 0x7FFFFFFF) continue;

        if (def.globalMesgNum === MESG_NUM_SESSION && SESSION_FIELDS[f.fieldDefNum]) {
          msg[SESSION_FIELDS[f.fieldDefNum]] = val;
        } else if (def.globalMesgNum === MESG_NUM_RECORD && RECORD_FIELDS[f.fieldDefNum]) {
          msg[RECORD_FIELDS[f.fieldDefNum]] = val;
        }
      }

      // Developer fields をスキップ
      if (def.devFields) {
        for (const df of def.devFields) offset += df.size;
      }

      if (def.globalMesgNum === MESG_NUM_SESSION && Object.keys(msg).length > 0) {
        sessions.push(msg);
      } else if (def.globalMesgNum === MESG_NUM_RECORD && msg.heart_rate) {
        records.push(msg);
      }
    }
  }

  return { sessions, records };
}

/**
 * セッションデータを正規化
 */
function normalizeSession(session) {
  const sportCode = session.sport ?? 0;
  let sport = SPORT_MAP[sportCode] || 'generic';
  // cycling系をbikeに統一
  if (sport === 'cycling' || sportCode === 2 || sportCode === 6) sport = 'bike';
  if (sport === 'running' || sportCode === 1) sport = 'run';
  if (sport === 'swimming' || sportCode === 5) sport = 'swim';

  return {
    sport,
    avgHR: session.avg_heart_rate || 0,
    maxHR: session.max_heart_rate || 0,
    durationSec: Math.round((session.total_elapsed_time || 0) / 1000), // FITはミリ秒
    distanceM: Math.round((session.total_distance || 0) / 100), // FITはcm
    cadence: session.avg_cadence || null,
    elevGain: session.total_ascent || 0,
    avgPower: session.avg_power || null,
  };
}

/**
 * レコード配列からランニングダイナミクスを集計
 */
function aggregateRecords(records) {
  let gctSum = 0, gctCount = 0;
  let voSum = 0, voCount = 0;

  for (const r of records) {
    if (r.stance_time && r.stance_time > 0 && r.stance_time < 1000) {
      gctSum += r.stance_time;
      gctCount++;
    }
    if (r.vertical_oscillation && r.vertical_oscillation > 0) {
      // FITのvertical_oscillationはmm単位で格納されることがある
      const vo = r.vertical_oscillation > 500 ? r.vertical_oscillation / 10 : r.vertical_oscillation;
      voSum += vo;
      voCount++;
    }
  }

  return {
    gct: gctCount > 0 ? Math.round(gctSum / gctCount) : null,
    vo: voCount > 0 ? Math.round((voSum / voCount) * 10) / 10 : null,
  };
}

/**
 * FITファイル（ArrayBuffer）を解析して統合結果を返す
 */
function analyzeFIT(arrayBuffer) {
  const { sessions, records } = parseFIT(arrayBuffer);

  if (sessions.length === 0) {
    throw new Error('セッションデータが見つかりません');
  }

  const session = normalizeSession(sessions[0]);
  const dynamics = aggregateRecords(records);

  return {
    ...session,
    gct: dynamics.gct,
    vo: dynamics.vo,
    recordCount: records.length,
  };
}

export { parseFIT, normalizeSession, aggregateRecords, analyzeFIT };
