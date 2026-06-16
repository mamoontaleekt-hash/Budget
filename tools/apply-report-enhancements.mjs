import { readFile, writeFile } from "node:fs/promises";

function replaceOnce(text, from, to, label) {
  if (!text.includes(from)) {
    if (text.includes(to)) return text;
    throw new Error(`Missing expected block: ${label}`);
  }
  return text.replace(from, () => to);
}

function insertBefore(text, marker, insert, label) {
  if (text.includes(insert.trim())) return text;
  if (!text.includes(marker)) throw new Error(`Missing marker: ${label}`);
  return text.replace(marker, () => `${insert}${marker}`);
}

function replaceBetween(text, start, end, replacement, label) {
  if (text.includes("function renderReportInsights(")) return text;
  const startIdx = text.indexOf(start);
  const endIdx = text.indexOf(end, startIdx);
  if (startIdx < 0 || endIdx < 0) throw new Error(`Missing function range: ${label}`);
  return text.slice(0, startIdx) + replacement + text.slice(endIdx);
}

function replaceOnceInRange(text, rangeStart, rangeEnd, from, to, label) {
  if (text.includes(to.trim())) return text;
  const startIdx = text.indexOf(rangeStart);
  const endIdx = text.indexOf(rangeEnd, startIdx);
  if (startIdx < 0 || endIdx < 0) throw new Error(`Missing range: ${label}`);
  const before = text.slice(0, startIdx);
  const range = text.slice(startIdx, endIdx);
  const after = text.slice(endIdx);
  return before + replaceOnce(range, from, to, label) + after;
}

const reportKpis = `          <div class="kpis">
            <div class="kpi">
              <div>
                <div class="label">متوسط المصروف الشهري</div>
                <div class="value" id="reportAvgExpense">—</div>
                <div class="hint">آخر 12 شهر حتى الشهر المحدد</div>
              </div>
              <span class="tag">📉</span>
            </div>
            <div class="kpi">
              <div>
                <div class="label">أفضل شهر صافي</div>
                <div class="value" id="reportBestNet">—</div>
                <div class="hint" id="reportBestNetMonth">—</div>
              </div>
              <span class="tag">🏁</span>
            </div>
            <div class="kpi">
              <div>
                <div class="label">تغير المصروف</div>
                <div class="value" id="reportExpenseChange">—</div>
                <div class="hint">مقارنة بالشهر السابق</div>
              </div>
              <span class="tag">↕️</span>
            </div>
            <div class="kpi">
              <div>
                <div class="label">الالتزام بالميزانية</div>
                <div class="value" id="reportBudgetCommitment">—</div>
                <div class="hint">التصنيفات المخططة ضمن الحد</div>
              </div>
              <span class="tag">✅</span>
            </div>
          </div>

          <div class="hr"></div>

`;

const insightSection = `          <div class="hr"></div>

          <div class="split">
            <div>
              <div style="font-weight:800;margin-bottom:4px">رؤى الشهر</div>
              <div class="mini">قراءة سريعة للأرقام الحالية مقارنة بالتاريخ والميزانية</div>
              <div id="reportInsights" style="margin-top:10px">—</div>
            </div>
            <div>
              <div style="font-weight:800;margin-bottom:4px">ملخص آخر 12 شهر</div>
              <div class="mini">الشهر الأحدث يظهر أولاً</div>
              <div style="margin-top:10px;overflow:auto">
                <table>
                  <thead>
                    <tr>
                      <th>الشهر</th>
                      <th>إيراد</th>
                      <th>مصروف</th>
                      <th>صافي</th>
                      <th>ادخار</th>
                    </tr>
                  </thead>
                  <tbody id="monthlySummaryBody">
                    <tr><td colspan="5" class="muted">—</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

`;

const enhancedReports = `  function renderReports(){
    // trend 12 months
    const months = lastNMonths(activeMonth, 12);
    const series = months.map(m=>{
      const t = totalsForMonth(m);
      return { month:m, income:t.income, expense:t.expense, net:t.net };
    });
    drawTrend("trendChart", series);

    const current = series[series.length-1] || {month: activeMonth, income:0, expense:0, net:0};
    const previous = series[series.length-2] || null;
    const avgExpense = series.reduce((s,x)=>s+x.expense,0) / Math.max(series.length, 1);
    const bestNet = series.reduce((best,x)=> x.net > best.net ? x : best, series[0] || current);

    // top categories
    const breakdown = expenseBreakdown(activeMonth);
    const totalExp = breakdown.reduce((s,x)=>s+x.value,0);
    const top = breakdown.slice(0,5);

    // plan vs actual inputs
    const plan = getBudgetForMonth(activeMonth);
    const expenseCats = categoriesByType("expense");
    const actualByCat = expenseByCategory(activeMonth);
    const plannedCats = expenseCats.filter(c => Number(plan.items?.[c.id]?.amount || 0) > 0);
    const committedCats = plannedCats.filter(c => Number(actualByCat[c.id] || 0) <= Number(plan.items?.[c.id]?.amount || 0));
    const budgetCommitment = plannedCats.length ? (committedCats.length / plannedCats.length) * 100 : null;

    $("#reportAvgExpense").textContent = fmtCompact(avgExpense);
    $("#reportBestNet").textContent = fmtCompact(bestNet.net);
    $("#reportBestNetMonth").textContent = bestNet.month || "—";
    $("#reportExpenseChange").textContent = previous && previous.expense > 0
      ? signedPercent(((current.expense - previous.expense) / previous.expense) * 100)
      : "—";
    $("#reportBudgetCommitment").textContent = budgetCommitment === null ? "—" : `\${budgetCommitment.toFixed(0)}%`;

    renderReportInsights({
      current,
      previous,
      avgExpense,
      topCategory: top[0],
      plannedCats,
      expenseCats,
      actualByCat,
      plan
    });
    renderMonthlySummary(series);

    const tbody = $("#topCatsBody");
    if(totalExp<=0){
      tbody.innerHTML = `<tr><td colspan="3" class="muted">لا توجد مصاريف في هذا الشهر.</td></tr>`;
    }else{
      tbody.innerHTML = top.map(x=>{
        const pct = totalExp>0 ? (x.value/totalExp)*100 : 0;
        return `<tr>
          <td><b>\${escapeHTML(x.label)}</b></td>
          <td>\${fmtCompact(x.value)}</td>
          <td>\${pct.toFixed(1)}%</td>
        </tr>`;
      }).join("");
    }

    // plan vs actual table
    const pv = $("#planVsActualBody");

    if(expenseCats.length===0){
      pv.innerHTML = `<tr><td colspan="5" class="muted">لا توجد تصنيفات مصروف.</td></tr>`;
      return;
    }

    pv.innerHTML = expenseCats.map(c=>{
      const planned = Number(plan.items?.[c.id]?.amount || 0);
      const actual = Number(actualByCat[c.id] || 0);
      const diff = planned - actual; // positive = under budget
      let status = `<span class="pill">بدون ميزانية</span>`;
      if(planned>0){
        status = diff>=0 ? `<span class="pill ok">ضمن الميزانية</span>` : `<span class="pill danger">تجاوز</span>`;
      }
      return `<tr>
        <td><b>\${escapeHTML(c.name)}</b></td>
        <td>\${planned>0 ? fmtCompact(planned) : "—"}</td>
        <td>\${fmtCompact(actual)}</td>
        <td>\${planned>0 ? fmtCompact(diff) : "—"}</td>
        <td>\${status}</td>
      </tr>`;
    }).join("");
  }

  function renderReportInsights({current, previous, avgExpense, topCategory, plannedCats, expenseCats, actualByCat, plan}){
    const box = $("#reportInsights");
    const insights = [];
    const hasMonthData = current.income > 0 || current.expense > 0;

    if(!hasMonthData){
      insights.push({kind:"warn", text:"لا توجد عمليات كافية لهذا الشهر حتى الآن."});
    }

    if(previous && previous.expense > 0){
      const delta = current.expense - previous.expense;
      const pct = (delta / previous.expense) * 100;
      const dir = delta > 0 ? "ارتفع" : "انخفض";
      const kind = delta > 0 ? "danger" : "ok";
      insights.push({kind, text:`المصروف \${dir} عن الشهر السابق بنسبة \${signedPercent(pct)} (\${signedMoney(delta)}).`});
    }

    if(avgExpense > 0){
      const deltaAvg = current.expense - avgExpense;
      const dir = deltaAvg > 0 ? "أعلى من" : "أقل من";
      const kind = deltaAvg > 0 ? "warn" : "ok";
      insights.push({kind, text:`مصروف هذا الشهر \${dir} متوسط آخر 12 شهر بمقدار \${fmtCompact(Math.abs(deltaAvg))}.`});
    }

    if(topCategory){
      insights.push({kind:"", text:`أكبر بند صرف حالياً هو \${topCategory.label} بقيمة \${fmtCompact(topCategory.value)}.`});
    }

    const overs = expenseCats.map(c=>{
      const planned = Number(plan.items?.[c.id]?.amount || 0);
      const actual = Number(actualByCat[c.id] || 0);
      return {name:c.name, planned, actual, over: actual - planned};
    }).filter(x => x.planned > 0 && x.over > 0).sort((a,b)=> b.over-a.over);

    if(overs[0]){
      insights.push({kind:"danger", text:`أكبر تجاوز ميزانية هو \${overs[0].name}: زائد \${fmtCompact(overs[0].over)} عن المخطط.`});
    }else if(plannedCats.length>0){
      insights.push({kind:"ok", text:"لا توجد تجاوزات في التصنيفات التي لها ميزانية مخططة."});
    }

    box.innerHTML = insights.map(ins => insightRow(ins.text, ins.kind)).join("");
  }

  function renderMonthlySummary(series){
    const tbody = $("#monthlySummaryBody");
    tbody.innerHTML = series.slice().reverse().map(s=>{
      const savingRate = s.income > 0 ? `\${((s.net / s.income) * 100).toFixed(1)}%` : "—";
      const netClass = s.net >= 0 ? "pos" : "neg";
      return `<tr>
        <td><b>\${escapeHTML(s.month)}</b></td>
        <td>\${fmtCompact(s.income)}</td>
        <td>\${fmtCompact(s.expense)}</td>
        <td class="money \${netClass}">\${fmtCompact(s.net)}</td>
        <td>\${savingRate}</td>
      </tr>`;
    }).join("");
  }

  function insightRow(text, kind=""){
    return `<div class="row" style="justify-content:space-between;padding:10px;border:1px solid rgba(16,24,40,.10);border-radius:14px;background:rgba(255,255,255,.78);margin-bottom:8px">
      <span>\${escapeHTML(text)}</span>
      <span class="pill \${kind}">\${kind==="danger" ? "تنبيه" : kind==="ok" ? "جيد" : kind==="warn" ? "مراجعة" : "معلومة"}</span>
    </div>`;
  }

`;

const signedHelpers = `  function signedPercent(v){
    const n = Number(v||0);
    const sign = n > 0 ? "+" : "";
    return `\${sign}\${n.toFixed(1)}%`;
  }

  function signedMoney(v){
    const n = Number(v||0);
    const sign = n > 0 ? "+" : "";
    return `\${sign}\${fmtCompact(n)}`;
  }

`;

export function applyToText(input) {
  let text = input;

  text = replaceOnceInRange(text,
    '<section id="view-reports"',
    '<!-- SETTINGS -->',
    `        <div class="bd">
          <div class="split">`,
    `        <div class="bd">
${reportKpis}          <div class="split">`,
    "report KPI cards"
  );

  text = replaceOnceInRange(text,
    '<section id="view-reports"',
    '<!-- SETTINGS -->',
    `          <div class="hr"></div>

          <div class="row" style="justify-content:space-between;align-items:flex-start">`,
    `${insightSection}          <div class="hr"></div>

          <div class="row" style="justify-content:space-between;align-items:flex-start">`,
    "report insights section"
  );

  text = replaceBetween(text, "  function renderReports(){", "  function renderSettings(){", enhancedReports, "renderReports");
  text = insertBefore(text, "  function getFontFallback(){ return \"Tahoma, Arial, sans-serif\"; }", signedHelpers, "signed helpers");
  return text;
}

export async function applyToFile(inputPath = "index.html", outputPath = inputPath) {
  const input = await readFile(inputPath, "utf8");
  const output = applyToText(input);
  await writeFile(outputPath, output, "utf8");
  return { changed: input !== output, bytes: Buffer.byteLength(output, "utf8") };
}

if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("apply-report-enhancements.mjs")) {
  const inputPath = process.argv[2] || "index.html";
  const outputPath = process.argv[3] || inputPath;
  applyToFile(inputPath, outputPath)
    .then((result) => console.log(JSON.stringify(result)))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
