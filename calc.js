/* 退稅計算：純函式，瀏覽器與 Node 測試共用 */
(function (root) {
  'use strict';
  const Calc = {};

  /** 含稅金額 + 稅率(%) → 未稅與稅額（四捨五入到整數日圓） */
  Calc.splitTax = function (incl, rate) {
    incl = Math.round(Number(incl) || 0);
    rate = Number(rate) || 0;
    const excl = Math.round(incl / (1 + rate / 100));
    return { excl: excl, tax: incl - excl };
  };

  /** 本地日期 YYYY-MM-DD */
  Calc.localDate = function (d) {
    d = d || new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  };

  /** 同一人、同一店、同一天算一組 */
  Calc.groupKey = function (r) {
    return [r.owner || '', r.store || '', r.date || ''].join('|');
  };

  /** 依「人+店+日」分組，未稅合計 >= 門檻才可退稅 */
  Calc.groupReceipts = function (list, threshold) {
    const map = new Map();
    list.forEach(function (r) {
      const k = Calc.groupKey(r);
      let g = map.get(k);
      if (!g) {
        g = { key: k, owner: r.owner, ownerName: r.ownerName, store: r.store, date: r.date,
              receipts: [], incl: 0, tax: 0, excl: 0 };
        map.set(k, g);
      }
      g.receipts.push(r);
      g.incl += r.amountIncl || 0;
      // 馬上吃掉／使用的收據不會帶出境，不列入退稅門檻與退稅金額
      if (!r.consumed) {
        g.tax += r.tax || 0;
        g.excl += r.amountExcl || 0;
      }
    });
    const out = Array.from(map.values());
    out.forEach(function (g) {
      g.eligible = g.excl >= threshold;
      g.shortfall = g.eligible ? 0 : threshold - g.excl;
      g.refund = g.eligible ? g.tax : 0;
      g.packedAll = g.receipts.every(function (x) { return x.packed; });
    });
    out.sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date)) || String(a.store).localeCompare(String(b.store));
    });
    return out;
  };

  /** 距離出境期限還剩幾天（購買日 + limit 天）。負數代表已過期 */
  Calc.daysLeft = function (dateStr, todayStr, limit) {
    const p = String(dateStr).split('-').map(Number);
    const t = String(todayStr).split('-').map(Number);
    const deadline = Date.UTC(p[0], p[1] - 1, p[2]) + (limit || 90) * 86400000;
    const today = Date.UTC(t[0], t[1] - 1, t[2]);
    return Math.round((deadline - today) / 86400000);
  };

  Calc.deadlineDate = function (dateStr, limit) {
    const p = String(dateStr).split('-').map(Number);
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]) + (limit || 90) * 86400000);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  };

  /** 預算狀態：ok / warn(>=80%) / over(>=100%) / none(沒設定) */
  Calc.budgetStatus = function (spent, budget) {
    if (!budget || budget <= 0) return { level: 'none', ratio: 0 };
    const ratio = spent / budget;
    return { level: ratio >= 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'ok', ratio: ratio };
  };

  Calc.toTWD = function (jpy, rate) {
    return Math.round((Number(jpy) || 0) * (Number(rate) || 0));
  };

  /** 文字正規化，用來比對店名 */
  Calc.norm = function (s) {
    return String(s || '').normalize('NFKC').toLowerCase().replace(/[\s・･\-_.,()（）【】]/g, '');
  };

  /** 用收據辨識出的店名，去比對店家清單（名稱、日文、別名） */
  Calc.matchStore = function (text, stores) {
    const t = Calc.norm(text);
    if (t.length < 2) return null;
    let best = null, bestLen = 0;
    stores.forEach(function (s) {
      const keys = [s.name, s.nameJa].concat(String(s.aliases || '').split(','));
      keys.forEach(function (k) {
        const n = Calc.norm(k);
        if (n.length < 2) return;
        if ((t.indexOf(n) !== -1 || n.indexOf(t) !== -1) && n.length > bestLen) {
          best = s; bestLen = n.length;
        }
      });
    });
    return best;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Calc;
  else root.Calc = Calc;
})(typeof window !== 'undefined' ? window : globalThis);
